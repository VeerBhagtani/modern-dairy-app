/* Modern Drivers — branding.
 *
 * Everything that makes this app look like Modern Dairy lives here. Change
 * these values (and swap logo.png) and the app is rebranded: nothing else in
 * the app reads a colour, a product name or a logo path from anywhere else.
 * The theme is applied to CSS custom properties at boot by app.js.
 */
window.BRANDING = {
  appName: 'Modern Drivers',
  companyName: 'Modern Dairy, Pune',
  // Two files, because one image cannot do both jobs. The lockup carries the
  // wordmark and the strapline and needs room to be read; the mark alone is
  // what survives at 26px in a header or on a launcher.
  logo: 'logo.png',
  mark: 'mark.png',
  supportPhone: '',          // shown on the "call the office" prompts when set
  theme: {
    // "Modern" navy and crest red, matching the customer app's tokens.
    brand: '#1B2A6B',
    brandDark: '#101B49',
    accent: '#D7262F',
    ok: '#1a7a4c',
    warn: '#8a5f14',
    warnTint: '#faf1de',
    bad: '#b3261e',
    badTint: '#fbe4e2',
    okTint: '#e2f3e9',
    bg: '#f1f2ee',
    surface: '#ffffff',
    line: '#dee1db',
    ink: '#161b22',
    ink2: '#4b5768',
  },
};
