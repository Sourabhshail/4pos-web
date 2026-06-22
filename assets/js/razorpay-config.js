/**
 * Razorpay public config — safe to expose key_id in the browser.
 * Amounts are in the smallest currency unit (cents for USD).
 * Enable International Payments in Razorpay Dashboard for USD checkout.
 */
window.RAZORPAY_CONFIG = {
  keyId: 'rzp_live_T4ZqUJNCWHgdaB',
  apiBase: '',
  companyName: '4POS IT Solutions',
  logoUrl: 'assets/4pos-logo.png',
  defaultCurrency: 'USD',
  customPayment: {
    currency: 'USD',
    minDollars: 1,
    maxDollars: 50000,
    name: 'Custom payment',
    description: '4POS custom payment'
  },
  plans: {
    starter: {
      amount: 6200,
      currency: 'USD',
      name: 'Starter Licence',
      description: '4POS Starter — 1 PC licence (once-off)'
    },
    professional: {
      amount: 16000,
      currency: 'USD',
      name: 'Professional Licence',
      description: '4POS Professional — up to 3 PC licences (once-off)'
    },
    'pay-as-you-go': {
      amount: 3100,
      currency: 'USD',
      name: 'Pay as you go',
      description: 'Live help — hourly support package'
    },
    'monthly-care': {
      amount: 18000,
      currency: 'USD',
      name: 'Monthly care',
      description: 'Live help — monthly package (max 10 hours)'
    },
    'power-user': {
      amount: 30000,
      currency: 'USD',
      name: 'Power user',
      description: 'Live help — yearly package (max 20 hours)'
    }
  }
};
