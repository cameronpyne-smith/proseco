const assert = require("node:assert");
const http = require("node:http");
const { getText } = require("./index.js");

const server = http.createServer((request, response) => response.end("hello")).listen(0, "127.0.0.1", async () => {
  try {
    const text = await getText(`http://127.0.0.1:${server.address().port}/`, { agent: new http.Agent() });
    assert.strictEqual(text, "hello");
  } finally {
    server.close();
  }
});
