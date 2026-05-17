// Plan → features + Stripe price IDs.

const PLANS = {
  trial: {
    max_devices: 1,
    duration_days: 7,
    features: {
      bulk_export: false,
      multi_db_count_max: 1,
      project_backup: false,
      max_export_mb: 50,
    },
    stripe_price: null,  // Trial isn't sold; auto-issued on register
  },
  basic: {
    max_devices: 1,
    features: {
      bulk_export: true,
      multi_db_count_max: 5,
      project_backup: true,
      max_export_mb: null,
    },
    stripe_price: process.env.STRIPE_PRICE_BASIC || null,
    ecpay_amount_twd: Number(process.env.ECPAY_AMOUNT_BASIC || 990),         // TWD / year
  },
  team: {
    max_devices: 5,
    features: {
      bulk_export: true,
      multi_db_count_max: null,
      project_backup: true,
      max_export_mb: null,
    },
    stripe_price: process.env.STRIPE_PRICE_TEAM || null,
    ecpay_amount_twd: Number(process.env.ECPAY_AMOUNT_TEAM || 3990),
  },
  enterprise: {
    max_devices: 999,
    features: {
      bulk_export: true,
      multi_db_count_max: null,
      project_backup: true,
      max_export_mb: null,
    },
    stripe_price: process.env.STRIPE_PRICE_ENTERPRISE || null,
    ecpay_amount_twd: Number(process.env.ECPAY_AMOUNT_ENTERPRISE || 19900),
  },
};

function getPlan(name) { return PLANS[name] || PLANS.trial; }

// "Free this month" override — returns the highest plan's features regardless of the user's actual plan.
function freeOverridePlan() {
  return PLANS.team;  // team-equivalent for free overrides
}

module.exports = { PLANS, getPlan, freeOverridePlan };
