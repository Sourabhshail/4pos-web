(function () {
  const config = window.RAZORPAY_CONFIG;
  if (!config || !config.keyId || config.keyId.includes('REPLACE')) {
    console.warn('Razorpay: set your key in assets/js/razorpay-config.js');
  }

  function apiUrl(path) {
    const base = (config.apiBase || '').replace(/\/$/, '');
    return base + path;
  }

  function setButtonLoading(btn, loading) {
    if (!btn) return;
    btn.disabled = loading;
    btn.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (!btn.dataset.defaultLabel) {
      btn.dataset.defaultLabel = btn.textContent.trim();
    }
    btn.textContent = loading ? 'Opening checkout…' : btn.dataset.defaultLabel;
  }

  function dollarsToCents(value) {
    return Math.round(Number(value) * 100);
  }

  function formatUsd(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  async function createOrder(planId, orderDetails) {
    const plan = config.plans && config.plans[planId];
    const amount = orderDetails.amount != null ? orderDetails.amount : plan && plan.amount;
    const currency = orderDetails.currency || (plan && plan.currency) || config.defaultCurrency || 'USD';

    if (!amount) {
      throw new Error('Payment amount is missing.');
    }

    const response = await fetch(apiUrl('/api/razorpay/create-order'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        planId,
        amount,
        currency,
        reference: orderDetails.reference || '',
        receipt: planId + '_' + Date.now()
      })
    });

    const data = await response.json().catch(function () {
      return {};
    });

    if (!response.ok) {
      throw new Error(data.error || 'Could not start payment. Is the payment server running?');
    }

    return data;
  }

  async function verifyPayment(payload) {
    const response = await fetch(apiUrl('/api/razorpay/verify-payment'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(function () {
      return {};
    });

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Payment verification failed.');
    }

    return data;
  }

  function openCheckout(order, checkoutMeta, btn) {
    if (typeof Razorpay === 'undefined') {
      alert('Payment library failed to load. Please refresh and try again.');
      setButtonLoading(btn, false);
      return;
    }

    const options = {
      key: config.keyId,
      amount: order.amount,
      currency: order.currency,
      name: config.companyName,
      description: checkoutMeta.description,
      image: config.logoUrl,
      order_id: order.id,
      theme: { color: '#1a6cff' },
      handler: async function (response) {
        try {
          await verifyPayment({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature
          });
          alert(
            'Payment successful! Payment ID: ' +
              response.razorpay_payment_id +
              '\n\nOur team will confirm your order and contact you shortly.'
          );
        } catch (err) {
          alert(err.message || 'Payment received but verification failed. Contact support with your payment ID.');
        } finally {
          setButtonLoading(btn, false);
        }
      },
      modal: {
        ondismiss: function () {
          setButtonLoading(btn, false);
        }
      }
    };

    const rzp = new Razorpay(options);
    rzp.on('payment.failed', function () {
      setButtonLoading(btn, false);
    });
    rzp.open();
  }

  async function startCheckout(planId, btn) {
    if (!config || !config.plans[planId]) return;

    if (!config.keyId || config.keyId.includes('REPLACE')) {
      alert('Razorpay is not configured yet. Add your Key ID in assets/js/razorpay-config.js and deploy the ASP.NET site with razorpay.env.');
      return;
    }

    const plan = config.plans[planId];
    setButtonLoading(btn, true);

    try {
      const order = await createOrder(planId, {
        amount: plan.amount,
        currency: plan.currency
      });
      openCheckout(order, { description: plan.description }, btn);
    } catch (err) {
      alert(err.message || 'Unable to start checkout.');
      setButtonLoading(btn, false);
    }
  }

  function validateCustomAmount(dollars) {
    const custom = config.customPayment || {};
    const min = custom.minDollars != null ? custom.minDollars : 1;
    const max = custom.maxDollars != null ? custom.maxDollars : 50000;

    if (!Number.isFinite(dollars) || dollars <= 0) {
      throw new Error('Enter a valid payment amount.');
    }
    if (dollars < min) {
      throw new Error('Minimum payment is ' + formatUsd(dollarsToCents(min)) + '.');
    }
    if (dollars > max) {
      throw new Error('Maximum payment is ' + formatUsd(dollarsToCents(max)) + '.');
    }

    const cents = dollarsToCents(dollars);
    if (cents < 100) {
      throw new Error('Minimum payment is $1.00.');
    }

    return cents;
  }

  async function startCustomCheckout(form, btn) {
    if (!config.keyId || config.keyId.includes('REPLACE')) {
      alert('Razorpay is not configured yet. Add your Key ID in assets/js/razorpay-config.js and deploy the ASP.NET site with razorpay.env.');
      return;
    }

    const amountInput = form.querySelector('[data-custom-amount]');
    const noteInput = form.querySelector('[data-custom-note]');
    const dollars = parseFloat(amountInput && amountInput.value);
    const reference = noteInput && noteInput.value ? noteInput.value.trim() : '';
    const custom = config.customPayment || {};
    const currency = custom.currency || config.defaultCurrency || 'USD';

    let cents;
    try {
      cents = validateCustomAmount(dollars);
    } catch (err) {
      alert(err.message);
      return;
    }

    const description = reference
      ? custom.description + ' — ' + reference
      : custom.description;

    setButtonLoading(btn, true);

    try {
      const order = await createOrder('custom', {
        amount: cents,
        currency,
        reference
      });
      openCheckout(order, { description }, btn);
    } catch (err) {
      alert(err.message || 'Unable to start checkout.');
      setButtonLoading(btn, false);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-razorpay-plan]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        startCheckout(btn.getAttribute('data-razorpay-plan'), btn);
      });
    });

    document.querySelectorAll('[data-razorpay-custom-form]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        const btn = form.querySelector('[data-razorpay-custom-submit]');
        startCustomCheckout(form, btn);
      });
    });
  });
})();
