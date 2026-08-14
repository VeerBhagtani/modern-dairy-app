// GoFrugal RPOS/RetailEasy REST API (https://www.gofrugal.com — API docs vary by
// product edition; this targets the common "Advanced Web API" pattern: an
// X-Auth-Token header plus outlet/company IDs as query params). Confirm the exact
// base URL with GoFrugal support for your specific edition/tenant.
const { getSecret } = require('./secretManager');

const BASE_URL = process.env.GOFRUGAL_API_BASE_URL || 'https://api.gofrugal.com/rayapi/v1';

async function creds() {
  const apiKey = await getSecret('gofrugal');
  const outletId = await getSecret('gofrugal_outlet_id');
  const companyId = await getSecret('gofrugal_company_id');
  if (!apiKey || !outletId) {
    const err = new Error('GoFrugal is not configured yet. Add the API key and outlet ID in Admin Panel → API keys.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return { apiKey, outletId, companyId };
}

async function pushSalesOrder(order) {
  const { apiKey, outletId, companyId } = await creds();
  const res = await fetch(`${BASE_URL}/salesOrders?outletId=${outletId}${companyId ? `&companyId=${companyId}` : ''}`, {
    method: 'POST',
    headers: { 'X-Auth-Token': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderNo: order.orderNo,
      items: order.items.map(i => ({ itemCode: i.sku || i.productId, qty: i.qty, price: i.price })),
      customerPhone: order.customerPhone,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GoFrugal sync failed (${res.status}): ${body.slice(0, 300)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  return res.json();
}

module.exports = { pushSalesOrder };
