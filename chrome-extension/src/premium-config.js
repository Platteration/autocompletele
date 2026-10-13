// Release configuration only. Leave enforcement off until a real checkout and
// the issuer's PUBLIC P-256 key are configured. Never put a private key here.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ActlePremiumConfig = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  return Object.freeze({
    dailyLimit: 100,
    enforceDailyLimit: false,
    checkoutUrl: "",
    priceLabel: "",
    publicKeyJwk: null,
  });
});
