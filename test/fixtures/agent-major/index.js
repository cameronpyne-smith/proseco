const fetch = require("node-fetch");

async function getText(url, options) {
  const response = await fetch(url, options);
  return response.text();
}

module.exports = { getText };
