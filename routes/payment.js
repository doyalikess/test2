const express = require('express');
const router = express.Router();

router.post('/deposit', (req, res) => {
  const { amount, currency } = req.body;

  if (!amount || !currency) {
    return res.status(400).json({ error: 'Amount and currency are required' });
  }

  // Simulated response, replace this with your NOWPAYMENTS API call later
  const invoiceData = {
    invoice_url: `https://payment-platform.com/invoice?amount=${amount}&currency=${currency}`,
    invoice_id: '5410103245',
  };

  res.status(200).json(invoiceData);
});

module.exports = router;
