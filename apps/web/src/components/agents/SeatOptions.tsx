import { roleGroupInView } from '@aom/shared';
import { useEffectiveView } from '../../lib/orgMode.ts';

/**
 * The <option>s of a seat picker. Every seat is offered in every view; the roles of the other view sit under "More".
 * `suffix` adds text after a seat's name (for example "(suggested)").
 */
export function SeatOptions({
  seats,
  suffix,
}: {
  seats: Array<{ key: string; name: string }>;
  suffix?: (key: string) => string;
}) {
  const view = useEffectiveView();
  const main = seats.filter((s) => roleGroupInView(s.key, view) === 'main');
  const more = seats.filter((s) => roleGroupInView(s.key, view) === 'more');
  const opt = (s: { key: string; name: string }) => (
    <option key={s.key} value={s.key}>
      {s.name}
      {suffix?.(s.key) ?? ''}
    </option>
  );
  return (
    <>
      {main.map(opt)}
      {more.length > 0 && <optgroup label="More">{more.map(opt)}</optgroup>}
    </>
  );
}
