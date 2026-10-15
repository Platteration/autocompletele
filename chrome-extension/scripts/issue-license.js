// Offline operator tool. The issuer's private key stays outside the extension.
// The token can be delivered after a purchase; this does not process payments.
const fs = require("node:fs");
const { createPrivateKey, createPublicKey, sign } = require("node:crypto");
const license = require("../src/license.js");

const USAGE = "Usage: node scripts/issue-license.js --private-key /secure/issuer.pem --id opaque-order-id [--issued-at YYYY-MM-DDTHH:mm:ss.sssZ]\n       node scripts/issue-license.js --private-key /secure/issuer.pem --public-key\n";

async function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!["--private-key", "--id", "--issued-at", "--public-key"].includes(name) || Object.prototype.hasOwnProperty.call(options, name)) throw new Error("Arguments");
    if (name === "--public-key") options[name] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("Arguments");
      options[name] = value;
    }
  }
  if (!options["--private-key"] || (!options["--public-key"] && !options["--id"]) ||
      (options["--public-key"] && (options["--id"] || options["--issued-at"]))) throw new Error("Arguments");
  const details = fs.statSync(options["--private-key"]);
  if (!details.isFile() || details.size > 65536) throw new Error("Key file");
  const key = createPrivateKey(fs.readFileSync(options["--private-key"]));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("Key type");
  const publicKey = createPublicKey(key).export({ format: "jwk" });
  if (options["--public-key"]) {
    process.stdout.write(JSON.stringify(publicKey, null, 2) + "\n");
    return;
  }
  const payload = {
    version: 1, product: "actle", plan: "forever", id: options["--id"],
    issuedAt: options["--issued-at"] || new Date().toISOString(),
  };
  const message = "actle1." + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign("sha256", Buffer.from(message), { key, dsaEncoding: "ieee-p1363" });
  const token = message + "." + signature.toString("base64url");
  // The shipping verifier is also the issuer's schema/interoperability check.
  if (!(await license.verify(token, publicKey)).valid) throw new Error("License data");
  process.stdout.write(token + "\n");
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(() => {
    // Do not print crypto exceptions, key material, arguments, or local paths.
    process.stderr.write("Unable to issue a license. Check the arguments and use an unencrypted ECDSA P-256 private key file.\n" + USAGE);
    process.exitCode = 1;
  });
}
