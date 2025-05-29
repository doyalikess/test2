const crypto = require('crypto');

const ipnSecret = 'f1BDYsCmoO0+mKHmyAQfrlWduOj1F0A6';

// This JSON string must be exactly the same you send in the webhook POST body — no spaces or newlines inside strings
const payload = '{"payment_status":"confirmed","order_id":"order_1685152000000_683470571adede25b411430a","price_amount":5}';

const signature = crypto.createHmac('sha256', ipnSecret).update(payload).digest('hex');

console.log('Signature:', signature);
