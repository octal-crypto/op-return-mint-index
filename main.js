const fs = require('fs');

// read checkpoint files
const START_HEIGHT = parseInt(fs.readFileSync('block')) + 1;
const mints = JSON.parse(fs.readFileSync('mints'));
let totalMinted = Object.values(mints).reduce((prev, curr) => prev+curr, 0);

// increase if http 429
const SLEEP_INTERVAL_MS = 0;
const BASE_URL = 'https://mempool.space/api';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} - ${url}`);
  }
  return response.text();
}

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} - ${url}`);
  }
  return response.json();
}

function extractOpReturnData(scriptPubKeyHex) {
  const buffer = Buffer.from(scriptPubKeyHex, 'hex');
  let offset = 0;

  if (buffer[offset] !== 0x6a) {
    return null;
  }
  offset += 1;

  if (offset >= buffer.length) {
    return '';
  }

  let dataLength = 0;
  let opcode = buffer[offset];
  offset += 1;

  if (opcode <= 0x4b) {
    dataLength = opcode;
  } else if (opcode === 0x4c) {
    if (offset >= buffer.length) return null;
    dataLength = buffer[offset];
    offset += 1;
  } else if (opcode === 0x4d) {
    if (offset + 1 >= buffer.length) return null;
    dataLength = buffer.readUInt16LE(offset);
    offset += 2;
  } else if (opcode === 0x4e) {
    if (offset + 3 >= buffer.length) return null;
    dataLength = buffer.readUInt32LE(offset);
    offset += 4;
  } else {
    return null;
  }

  if (offset + dataLength > buffer.length) {
    return null;
  }

  const dataBuffer = buffer.slice(offset, offset + dataLength);
  return dataBuffer.toString('utf8');
}

function validateJson(jsonString) {
  try {
    const obj = JSON.parse(jsonString);
    return (
      typeof obj === 'object' &&
      obj !== null &&
      obj.p === 'op-20' &&
      obj.op === 'mint' &&
      obj.tick === 'op_return'
      // todo: invalid addresses?
    ) && parseInt(obj.amt) <= 1000 && obj.add.length > 0 ? obj : null;
  } catch (e) {
    return null;
  }
}


async function processBlock(height) {
  try {
    const blockHash = await fetchText(`${BASE_URL}/block-height/${height}`);
    const blockData = await fetchJSON(`${BASE_URL}/block/${blockHash}`);
    const txCount = blockData.tx_count;

    outer: for (let start = 0; start < txCount; start += 25) {
      const txs = await fetchJSON(`${BASE_URL}/block/${blockHash}/txs/${start}`);
      for (const tx of txs) {
        for (const vout of tx.vout) {
          if (vout.scriptpubkey_type === 'op_return') {
            const data = validateJson(extractOpReturnData(vout.scriptpubkey));
            if (data) {
              console.log(`Block: ${height}, TXID: ${tx.txid}\nData: ${JSON.stringify(data)}`);
              totalMinted += parseInt(data.amt);
              console.log(`totalMinted: ${totalMinted}\n`);

              if (!mints[data.add]) mints[data.add] = 0;
              mints[data.add] += parseInt(data.amt);
              // console.log(mints);

              if (totalMinted >= 2100000) break outer; // todo: overflow?
              break; // dont allow multiple outputs
            }
          }
        }
      }
      await sleep(SLEEP_INTERVAL_MS);
    }

    // checkpoint block
    fs.writeFileSync('block', height.toString());
    fs.writeFileSync('mints', JSON.stringify(mints, null, 2))
  } catch (error) {
    console.error(`Error processing block ${height}: ${error.message}`);
  }
}

(async () => {
  try {
    const tipHeightText = await fetchText(`${BASE_URL}/blocks/tip/height`);
    const tipHeight = parseInt(tipHeightText, 10);

    for (let height = START_HEIGHT; height <= tipHeight && totalMinted < 2100000; height++) {
      console.log(`Processing block ${height}...`);
      await processBlock(height);
      await sleep(SLEEP_INTERVAL_MS);
    }
    console.log('done')
  } catch (error) {
    console.error(`Fatal error: ${error.message}`);
  }
})();
