// Axe pass over every route in light and dark (WCAG 2 A/AA + 2.2 AA). Fails on serious and critical violations.
//   node apps/web/scripts/ui-a11y.mjs [--only=board,desk] [--sizes=d,m]
import { AxeBuilder } from '/path/to/guildwise/e2e/node_modules/@axe-core/playwright/dist/index.mjs';
import { chromium } from '/path/to/guildwise/e2e/node_modules/@playwright/test/index.mjs';
import { base, connect } from './ui-routes.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const only = flag('only', '').split(',').filter(Boolean);
const sizes = flag('sizes', 'd').split(',');
const { storageState, routes } = await connect();
const vp = { d: { width: 1440, height: 900 }, m: { width: 390, height: 844 } };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
let bad = 0;
for (const sk of sizes)
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({
      viewport: vp[sk],
      colorScheme: scheme,
      reducedMotion: 'reduce',
      storageState,
    });
    await ctx.addInitScript((s) => localStorage.setItem('guildwise-theme', s), scheme);
    const p = await ctx.newPage();
    for (const [name, path] of Object.entries(routes)) {
      if (only.length && !only.includes(name)) continue;
      await p.goto(base + path);
      await p.waitForLoadState('networkidle').catch(() => undefined);
      await p.waitForTimeout(300);
      const res = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
      console.log(
        name,
        sk,
        scheme,
        'violations:',
        res.violations.map((v) => v.id + ':' + v.impact).join(',') || 'none',
      );
      const hits = res.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
      for (const v of hits) {
        bad++;
        console.log(
          `${name} ${sk} ${scheme}: ${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes
            .slice(0, 3)
            .map((n) => n.target.join(' '))
            .join(' | ')}`,
        );
        if (v.id === 'color-contrast')
          for (const n of v.nodes.slice(0, 2)) console.log(`   ${n.any[0]?.message}`);
      }
    }
    await ctx.close();
  }
await browser.close();
console.log(bad ? `${bad} violations` : 'no serious or critical violations');
process.exit(bad ? 1 : 0);
