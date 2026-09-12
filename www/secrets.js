/* GENERATED AT BUILD TIME from CI secrets by scripts/inject-secrets.js.
   Never commit real values here — see the header of that script.

   DEMO_BUILD is not a secret: it is the explicit opt-in for the OTP test path
   (every number accepts 0000) and is only honoured when no real OTP credential
   is present. It is "true" here so that serving this directory locally still
   demos end to end; CI overwrites this file and defaults the flag to off, and
   inject-secrets.js refuses to set it alongside real credentials. */
window.APP_SECRETS = {
  "OTP_CUSTOMER_ID": "",
  "OTP_AUTH_TOKEN": "",
  "GST_API_KEY": "",
  "GST_API_SECRET": "",
  "DEMO_BUILD": "true"
};
