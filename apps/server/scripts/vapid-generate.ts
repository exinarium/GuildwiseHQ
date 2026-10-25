import webpush from 'web-push';

// Prints a VAPID key pair for Web Push. Run once per environment and put the lines in the server's environment file
// (docs/SELF-HOSTING.md "Web Push"). In the production image: `docker compose -f docker-compose.prod.yml exec app node dist/vapid-generate.mjs`. Changing the key later makes every browser subscription invalid: people enable
// notifications on their devices again.
const keys = webpush.generateVAPIDKeys();
console.log(`AOM_VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`AOM_VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(
  'AOM_VAPID_SUBJECT=mailto:you@example.com   # a contact the push services can reach; or an https:// URL',
);
