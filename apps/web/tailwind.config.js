/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: { extend: { colors: { bondoq: { red: "#D32F2F", deep: "#B71C1C", blush: "#FFEBEE", gold: "#FFC107", cream: "#FFFDF7", butter: "#FFF8E1" } }, fontFamily: { sans: ["Cairo", "sans-serif"] } } },
  plugins: []
};
