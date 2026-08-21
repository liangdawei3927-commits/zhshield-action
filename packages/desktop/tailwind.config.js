/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#1A6B36',
          dark: '#14522C',
          light: '#D1E7D8',
          lighter: '#E8F5EC',
          green: '#1A6B36',
          blue: '#3B82F6',
          orange: '#F59E0B',
          red: '#EF4444',
        },
      },
    },
  },
  plugins: [],
};
