const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const dayjs = require('dayjs');

const app = express();
app.use(express.json());

// -------------------- ENV VARIABLES --------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const ULTRAMSG_INSTANCE = process.env.ULTRAMSG_INSTANCE;
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN;
const WEBSITE_URL = process.env.WEBSITE_URL;
// ---------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ---------------- WhatsApp Helper ----------------
async function sendWhatsApp(to, body) {
  try {
    await axios.post(
      `https://api.ultramsg.com/${ULTRAMSG_INSTANCE}/messages/chat`,
      { token: ULTRAMSG_TOKEN, to, body },
      { headers: { 'Content-Type': 'application/json' } } // important
    );
  } catch (err) {
    console.error('WhatsApp send error:', err.response?.data || err.message);
  }
}

// ---------------- Update Investments ----------------
async function updateInvestments() {
  const { data: investments } = await supabase.from('investments').select('*').eq('active', true);
  if (!investments) return;

  for (const inv of investments) {
    const { data: plan } = await supabase.from('plans').select('*').eq('id', inv.plan_id).single();
    const { data: user } = await supabase.from('users').select('*').eq('id', inv.user_id).single();

    const today = dayjs().startOf('day');
    const lastCalc = dayjs(inv.last_calculated || inv.start_date);
    const daysPassed = today.diff(lastCalc, 'day');

    if (daysPassed > 0) {
      const dailyProfit = plan.daily_return * inv.amount / 100;
      const totalProfit = dailyProfit * daysPassed;

      await supabase.from('users').update({ balance: user.balance + totalProfit }).eq('id', user.id);
      await supabase.from('investments').update({ last_calculated: today.format('YYYY-MM-DD') }).eq('id', inv.id);

      await sendWhatsApp(user.phone, `Your daily earning from ${plan.name} is ${totalProfit}. Current balance: ${user.balance + totalProfit}.`);
    }

    if (today.isAfter(dayjs(inv.end_date))) {
      await supabase.from('investments').update({ active: false }).eq('id', inv.id);
      await sendWhatsApp(user.phone, `Your investment in ${plan.name} has ended. Total earnings added to your balance.`);
    }
  }
}

// ---------------- Daily Reports ----------------
async function sendFinancialReports() {
  const { data: users } = await supabase.from('users').select('*');
  if (!users) return;

  for (const user of users) {
    const { data: investments } = await supabase.from('investments').select('*').eq('user_id', user.id);
    const { data: transactions } = await supabase.from('transactions').select('*')
      .eq('user_id', user.id)
      .gte('created_at', dayjs().subtract(1, 'day').format());

    let report = `Hello ${user.name}, here is your daily financial report:\n\nBalance: ${user.balance}\n\n`;

    report += 'Active Investments:\n';
    if (!investments || investments.length === 0) report += 'None\n';
    else investments.forEach(inv => {
      report += `- ${inv.amount} in Plan ${inv.plan_id}, Active: ${inv.active}, Ends: ${inv.end_date}\n`;
    });

    report += '\nTransactions Today:\n';
    if (!transactions || transactions.length === 0) report += 'None\n';
    else transactions.forEach(tr => {
      report += `- ${tr.type} of ${tr.amount}, Status: ${tr.status}\n`;
    });

    await sendWhatsApp(user.phone, report);
  }
}

// ---------------- Schedule Jobs ----------------
setInterval(updateInvestments, 1000 * 60 * 60); // hourly
setInterval(sendFinancialReports, 1000 * 60 * 60 * 24); // daily

// ---------------- Homepage ----------------
app.get('/', (req, res) => {
  res.send('Zent Finance AI is running! Send POST requests to /webhook for WhatsApp messages.');
});

// ---------------- Webhook ----------------
app.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook hit:', JSON.stringify(req.body, null, 2));

    const data = req.body.data;
    if (!data) return res.sendStatus(400);

    const from = data.from;
    const message = data.body?.trim();
    if (!from || !message) return res.sendStatus(400);

    console.log('Parsed message:', { from, message });

    // -------- Get user --------
    const { data: users } = await supabase.from('users').select('*').eq('phone', from);
    const user = users?.[0];
    if (!user) {
      await sendWhatsApp(from, `Hello! I could not find your account. Please register on the website first.`);
      return res.sendStatus(404);
    }

    // -------- Fetch plans & investments --------
    const { data: plans } = await supabase.from('plans').select('*');
    const { data: investments } = await supabase.from('investments').select('*').eq('user_id', user.id).eq('active', true);

    // -------- Fetch website content --------
    let websiteContent = '';
    try { websiteContent = (await axios.get(WEBSITE_URL)).data; } catch (err) { console.error('Website fetch error:', err.message); }

    let reply = '';

    // -------- Handle deposit --------
    const depositMatch = message.match(/deposit (\d+)/i);
    if (depositMatch) {
      const amount = parseFloat(depositMatch[1]);
      await supabase.from('users').update({ balance: user.balance + amount }).eq('id', user.id);
      await supabase.from('transactions').insert([{ user_id: user.id, type: 'deposit', amount, status: 'approved', created_at: dayjs().format() }]);
      reply = `Deposit of ${amount} successful. New balance: ${user.balance + amount}.`;
    }

    // -------- Handle withdraw --------
    const withdrawMatch = message.match(/withdraw (\d+)/i);
    if (withdrawMatch) {
      const amount = parseFloat(withdrawMatch[1]);
      if (amount > user.balance) reply = `You do not have enough balance.`;
      else {
        await supabase.from('users').update({ balance: user.balance - amount }).eq('id', user.id);
        await supabase.from('transactions').insert([{ user_id: user.id, type: 'withdraw', amount, status: 'approved', created_at: dayjs().format() }]);
        reply = `Withdrawal of ${amount} successful. New balance: ${user.balance - amount}.`;
      }
    }

    // -------- Handle invest --------
    const investMatch = message.match(/invest (\d+) (\w+)/i);
    if (investMatch) {
      const amount = parseFloat(investMatch[1]);
      const planName = investMatch[2].toUpperCase();
      const plan = plans.find(p => p.name.toUpperCase() === planName);

      if (!plan) reply = `Plan ${planName} not found.`;
      else if (amount < plan.min_investment) reply = `Minimum investment for ${planName} is ${plan.min_investment}.`;
      else if (amount > user.balance) reply = `You do not have enough balance.`;
      else {
        const startDate = dayjs();
        const endDate = startDate.add(plan.duration_days, 'day');
        await supabase.from('investments').insert([{
          user_id: user.id,
          plan_id: plan.id,
          amount,
          start_date: startDate.format('YYYY-MM-DD'),
          end_date: endDate.format('YYYY-MM-DD'),
          last_calculated: startDate.format('YYYY-MM-DD'),
          active: true
        }]);
        await supabase.from('users').update({ balance: user.balance - amount }).eq('id', user.id);
        reply = `Investment of ${amount} in ${plan.name} started! Ends on ${endDate.format('YYYY-MM-DD')}.`;
      }
    }

    // -------- GPT fallback --------
    if (!reply) {
      const gptPrompt = `
You are a smart AI financial assistant for Zent Finance.
User message: "${message}"
Website content: "${websiteContent}"
User data: ${JSON.stringify(user)}
Active investments: ${JSON.stringify(investments)}
Investment plans: ${JSON.stringify(plans)}
Instructions:
- Answer balance, deposits, withdrawals, and investment questions.
- Provide expected returns if asked.
- Suggest best plan if asked.
- Respond naturally like a friendly finance advisor.
`;
      const gptResponse = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: gptPrompt }],
        max_tokens: 500
      });
      reply = gptResponse.choices[0].message.content;
    }

    await sendWhatsApp(from, reply);
    res.sendStatus(200);

  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zent Finance AI running on port ${PORT}`));
