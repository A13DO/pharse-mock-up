/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./src/**/*.{html,ts}",
    ],
    theme: {
        extend: {
            colors: {
                primary: {
                    DEFAULT: '#5c6bc0',
                    dark: '#3f51b5',
                    light: '#e8eaf6',
                },
            },
        },
    },
    plugins: [],
}
