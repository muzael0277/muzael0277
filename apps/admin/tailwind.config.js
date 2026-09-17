const preset = require('@bizbot/ui/tailwind-preset');

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [preset],
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
};
