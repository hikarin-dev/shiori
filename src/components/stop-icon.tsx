// StopIcon — the app's Stop mark, as 1.3 draws it on Tasks and the import tracker: a small filled
// square with round corners, 12 of the 24 units across (Lucide's Square is an 18-unit outline).
import type { SVGProps } from 'react';

export function StopIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
