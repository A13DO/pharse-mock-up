const HttpProxyMiddleware = require('http-proxy-middleware');

module.exports = {
    '/web/api2': {
        target: 'https://cloud.memsource.com',
        secure: true,
        changeOrigin: true,
        logLevel: 'debug',
        pathRewrite: {
            '^/web/api2': '/web/api2'
        },
        onProxyRes: (proxyRes, req, res) => {
            proxyRes.headers['Access-Control-Allow-Origin'] = '*';
            proxyRes.headers['Access-Control-Allow-Credentials'] = 'true';
            proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
            proxyRes.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
        }
    }
};
