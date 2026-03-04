const express = require('express');
const winston = require('winston');
const expressWinston = require('express-winston');
const path = require('path');
const compression = require('compression');
const axios = require('axios');
const app = express();
const port = 4000;

const args = process.argv.map((arg) => arg.trim());
function getArgValue(arg) {
  const i = args.indexOf(arg);
  if (i === -1) return;
  return args[i + 1];
}

const backend = getArgValue('--backend') === undefined ? process.env.HOST_URL : getArgValue('--backend');

app.use(expressWinston.logger({
  transports: [
    new winston.transports.Console()
  ],
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  meta: false,
  msg: "HTTP {{req.method}} {{req.url}} {{res.statusCode}}",
  expressFormat: false,
  colorize: true,
  metaField: null
}));
app.use(compression());

// Inject environment variables into index.html
const fs = require('fs');
const indexHtmlPath = path.join(__dirname, '../public/index.html');

const getSiteConfig = () => {
  const siteTitle = process.env.SITE_TITLE || 'OSRS Group Tracker';
  const siteName = process.env.SITE_NAME || 'OSRS Group Tracker';
  return { siteTitle, siteName };
};

const injectConfig = (html) => {
  const { siteTitle, siteName } = getSiteConfig();
  const configScript = `<script>window.siteConfig = { title: '${siteName}', pageTitle: '${siteTitle}' };</script>`;
  const modifiedHtml = html.replace('</head>', `${configScript}</head>`);
  const titleModifiedHtml = modifiedHtml.replace('<title>OSRS Group Tracker</title>', `<title>${siteTitle}</title>`);
  return titleModifiedHtml;
};

// Middleware to intercept index.html requests and inject config
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    fs.readFile(indexHtmlPath, 'utf8', (err, data) => {
      if (err) {
        res.status(500).send('Error loading page');
        return;
      }
      res.set('Content-Type', 'text/html');
      res.send(injectConfig(data));
    });
  } else {
    next();
  }
});

app.use(express.static('public'));
app.use(express.static('.'));

if (backend) {
  console.log(`Backend for api calls: ${backend}`);
  app.use(express.json());
  app.use('/api*', (req, res, next) => {
    const forwardUrl = backend + req.originalUrl;
    console.log(`Calling backend ${forwardUrl}`);
    const headers = Object.assign({}, req.headers);
    delete headers.host;
    delete headers.referer;
    delete headers['content-length'];
    axios({
      method: req.method,
      url: forwardUrl,
      responseType: 'stream',
      headers,
      data: req.body
    }).then((response) => {
      res.status(response.status);
      res.set(response.headers);
      response.data.pipe(res);
    }).catch((error) => {
      if (error.response) {
        res.status(error.response.status);
        res.set(error.response.headers);
        error.response.data.pipe(res);
      } else if (error.request) {
        console.error('Proxy error (no response):', error.code, error.message);
        res.status(418).end();
      } else {
        console.error('Error', error.message);
        res.status(418).end();
      }
    });
  });
} else {
  console.log("No backend supplied for api calls, not going to handle api requests");
}

app.get('*', function (request, response) {
  if (request.path.includes('/map') && request.path.includes('.png')) {
    response.sendStatus(404);
  } else {
    response.sendFile(path.resolve('public', 'index.html'));
  }
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Listening on http://0.0.0.0:${port}`);
});