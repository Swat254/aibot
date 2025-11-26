const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { Configuration, OpenAIApi } = require('openai');
const dayjs = require('dayjs');

const app = express();
app.use(express.json());

// Supabase & OpenAI setup
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_KEY }));

// Send WhatsApp message
async function sendWhatsApp(to, body) {
  await axios.post(`https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`, {
    token: process.env.ULTRAMSG_TOKEN,
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

      await sendWhatsApp(user.phone, `Your daily earning from ${plan.name} is ${dailyProfit * daysPassed}. Current balance: ${user.balance + totalProfit}.`);
    }

    if (today.isAfter(dayjs(inv.end_date))) {
      await supabase.from('investments').update({ active: false }).eq('id', inv.id);
      await sendWhatsApp(user.phone, `Your investment in ${plan.name} has ended. Total earnings added to your balance.`);
    }
  }
}

// Send daily/weekly financial report
async function sendFinancialReports() {
  const { data: users } = await supabase.from('users').select('*');

  for (const user of users) {
    const { data: investments } = await supabase.from('investments').select('*').eq('user_id', user.id);
    const { data: transactions } = await supabase.from('transactions').select('*').eq('user_id', user.id)
      .gte('created_at', dayjs().subtract(1, 'day').format()); // daily report, change to 'week' for weekly

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

// Schedule investment update & daily report
setInterval(updateInvestments, 1000 * 60 * 60); // hourly
setInterval(sendFinancialReports, 1000 * 60 * 60 * 24); // daily (change to 7 days for weekly)

// Proactive suggestions
async function sendSuggestions() {
  const { data: users } = await supabase.from('users').select('*');
  const { data: plans } = await supabase.from('plans').select('*');

  for (const user of users) {
    const lastSent = user.last_suggestion_sent ? dayjs(user.last_suggestion_sent) : dayjs().subtract(2, 'day');
    if (dayjs().diff(lastSent, 'day') >= 1) {
      const affordablePlans = plans.filter(p => user.balance >= p.min_investment);
      if (affordablePlans.length === 0) continue;

      const suggestion = `Hi ${user.name}, based on your balance of ${user.balance}, you can invest in:\n` +
        affordablePlans.map(p => `${p.name}: ${p.duration_days} days, Daily Return ${p.daily_return}%`).join('\n') +
        `\nReply "Invest [amount] [PlanName]" to start an investment or ask me any questions about your account.`;

      await sendWhatsApp(user.phone, suggestion);
      await supabase.from('users').update({ last_suggestion_sent: dayjs().format('YYYY-MM-DD') }).eq('id', user.id);
    }
  }
}

setInterval(sendSuggestions, 1000 * 60 * 60 * 6); // every 6 hours

// WhatsApp webhook
app.post('/webhook', async (req, res) => {
  try {
    const { from, message } = req.body;
    const { data: users } = await supabase.from('users').select('*').eq('phone', from);
    const user = users[0];
    if (!user) return res.sendStatus(404);

    const { data: plans } = await supabase.from('plans').select('*');
    const { data: investments } = await supabase.from('investments').select('*').eq('user_id', user.id).eq('active', true);
    const websiteContent = (await axios.get(process.env.WEBSITE_URL)).data;

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

    // Natural language fallback
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