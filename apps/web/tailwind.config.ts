import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#0b1020',
        panel: '#111936',
        panelSoft: '#162044',
        line: 'rgba(255,255,255,0.08)',
        accent: '#f2c66d',
        accentSoft: '#f6ddb0',
      },
      boxShadow: {
        soft: '0 20px 60px rgba(0,0,0,0.25)',
      },
    },
  },
  plugins: [],
};

export default config;
