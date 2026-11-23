// cn() — joins class names and settles conflicts between Tailwind utilities, the last one winning.
// Told the theme's own names (styles/tokens.css): left to its defaults it takes text-13 for a colour,
// so `text-13 text-primary` would lose the size, and it can't tell rounded-6 from rounded-8. A test
// (app/tests/class-merge.test.mjs) holds these lists to tokens.css.
import { createCn } from 'cn/config';

export const TOKENS = {
  text: ['8', '9', '10', '10.5', '11', '11.5', '12', '12.5', '13', '14', '15', '16', '18', '20', '32', '34', '48'],
  radius: ['2', '3', '4', '5', '6', '8', '10', '12', 'pill', 'circle'],
  shadow: ['popover', 'toast', 'dialog', 'lift', 'knob'],
  ease: ['standard', 'out', 'emphasis', 'settle'],
  z: ['header', 'page-menu', 'page-overlay', 'dialog', 'dialog-raised', 'status', 'status-menu', 'menu', 'drop', 'tooltip', 'toast', 'notice', 'select'],
  duration: ['fast', 'base', 'open', 'move', 'slow'],
};

export const cn = createCn({
  extend: {
    theme: { text: TOKENS.text, radius: TOKENS.radius, shadow: TOKENS.shadow, ease: TOKENS.ease },
    classGroups: { z: [{ z: TOKENS.z }], duration: [{ duration: TOKENS.duration }] },
  },
});
