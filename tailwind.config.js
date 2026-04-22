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
                    50: '#f5f7ff',
                    100: '#e8eaf6',
                    600: '#5c6bc0',
                    700: '#3f51b5',
                },
            },
            animation: {
                'spin': 'spin 0.8s linear infinite',
            },
        },
    },
    plugins: [],
}
