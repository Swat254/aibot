const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { Configuration, OpenAIApi } = require('openai');
const dayjs = require('dayjs');

const app = express();
app.use(express.json());

// ------------------ TEST KEYS (hardcoded for testing) ------------------
const SUPABASE_URL = 'https://lqugtfzuffmtxoiljogs.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxdWd0Znp1ZmZtdHhvaWxqb2dzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM5NjIwNzQsImV4cCI6MjA3OTUzODA3NH0.4_rIKGhmnJp_NlXhBYXBA4079Ewz7qZ1D4zAxfNS_eU';
const OPENAI_KEY = 'sk-5678ijklmnopabcd5678ijklmnopabcd5678ijkl';
const ULTRAMSG_INSTANCE = 'instance152658';
const ULTRAMSG_TOKEN = 'ackcog87mi4qvvhj';
const WEBSITE_URL = 'https://zentfinance.netlify.app/';
// ------------------------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_KEY }));

// Function to send WhatsApp messages
async function sendWhatsApp(to, body) {
  await axios.post(`https://api.ultramsg.com/${ULTRAMSG_INSTANCE}/messages/chat`, {
    token: ULTRAMSG_TOKEN,
    to,
    body
  });
}

// Update investments and notify users
async function updateInvestments() {
  const { data: investments } = await supabase.from('investments').select('*').eq('active', true);

  for (const inv of investments) {
    const plan = (await supabase.from('plans').select('*').eq('id', inv.plan_id).single()).data;
    const user = (await supabase.from('users').select('*').eq('id', inv.user_id).single()).data;

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

// Send daily financial report
async function sendFinancialReports() {
  const { data: users } = await supabase.from('users').select('*');

  for (const user of users) {
    const { data: investments } = await supabase.from('investments').select('*').eq('user_id', user.id);
    const { data: transactions } = await supabase.from('transactions').select('*').eq('user_id', user.id)
      .gte('created_at', dayjs().subtract(1, 'day').format()); // daily report

    let report = `Hello ${user.name}, here is your daily financial report:\n\nBalance: ${user.balance}\n`;

    report += '\nActive Investments:\n';
    if (investments.length === 0) report += 'None\n';
    else investments.forEach(inv => {
      report += `- ${inv.amount} in Plan ${inv.plan_id}, Active: ${inv.active}, Ends: ${inv.end_date}\n`;
    });

    report += '\nTransactions Today:\n';
    if (transactions.length === 0) report += 'None\n';
    else transactions.forEach(tr => {
      report += `- ${tr.type} of ${tr.amount}, Status: ${tr.status}\n`;
    });

    await sendWhatsApp(user.phone, report);
  }
}

// Schedule investment updates & daily reports
setInterval(updateInvestments, 1000 * 60 * 60); // hourly
setInterval(sendFinancialReports, 1000 * 60 * 60 * 24); // daily

// WhatsApp webhook
app.post('/webhook', async (req, res) => {
  try {
    const { from, message } = req.body;
    const { data: users } = await supabase.from('users').select('*').eq('phone', from);
    const user = users[0];
    if (!user) return res.sendStatus(404);

    const { data: plans } = await supabase.from('plans').select('*');
    const { data: investments } = await supabase.from('investments').select('*').eq('user_id', user.id).eq('active', true);
    const websiteContent = (await axios.get(WEBSITE_URL)).data;

    let reply = '';

    // Deposit
    const depositMatch = message.match(/deposit (\d+)/i);
    if (depositMatch) {
      const amount = parseFloat(depositMatch[1]);
      await supabase.from('users').update({ balance: user.balance + amount }).eq('id', user.id);
      await supabase.from('transactions').insert([{ user_id: user.id, type: 'deposit', amount, status: 'approved', created_at: dayjs().format() }]);
      reply = `Deposit successful. New balance: ${user.balance + amount}.`;
    }

    // Withdraw
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

    // Invest
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

    // GPT fallback
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
      const gptResponse = await openai.createChatCompletion({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: gptPrompt }],
        max_tokens: 500
      });
      reply = gptResponse.data.choices[0].message.content;
    }

    await sendWhatsApp(from, reply);
    res.sendStatus(200);
  } catch (err) {
    console.error(err.message);
    res.sendStatus(500);
  }
});

app.listen(3000, () => console.log('Ultimate Financial Assistant AI running on port 3000'));
