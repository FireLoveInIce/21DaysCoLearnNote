const API_BASE = "https://li.quest/v1";
const STORAGE_KEYS = {
  settings: "lifi-monitor.settings.v1",
  history: "lifi-monitor.history.v1",
  quoteCalls: "lifi-monitor.quote-calls.v1",
  customTokens: "lifi-monitor.custom-tokens.v2",
};

const REQUEST_WINDOW_MS = 2 * 60 * 60 * 1000;
const LOCAL_REQUEST_LIMIT = 70;
const MAX_HISTORY = 80;
const MAX_LOGS = 24;
const DEFAULT_SENDER = "0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0";
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

const CHAINS = [
  {
    id: 8453,
    name: "Base",
    rpcUrl: "https://base-rpc.publicnode.com",
    tokens: [
      token("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USDC", "USD Coin", 6),
      token("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", "USDT", "Tether USD", 6),
      token("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", "DAI", "Dai Stablecoin", 18),
      token(NATIVE_TOKEN_ADDRESS, "ETH", "Ether", 18),
      token("0x4200000000000000000000000000000000000006", "WETH", "Wrapped Ether", 18),
      token("0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", "cbBTC", "Coinbase Wrapped BTC", 8),
    ],
  },
  {
    id: 42161,
    name: "Arbitrum",
    rpcUrl: "https://arbitrum-one-rpc.publicnode.com",
    tokens: [
      token("0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "USDC", "USD Coin", 6),
      token("0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "USDT", "Tether USD", 6),
      token("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", "DAI", "Dai Stablecoin", 18),
      token(NATIVE_TOKEN_ADDRESS, "ETH", "Ether", 18),
      token("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", "WETH", "Wrapped Ether", 18),
      token("0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", "WBTC", "Wrapped BTC", 8),
    ],
  },
  {
    id: 10,
    name: "Optimism",
    rpcUrl: "https://optimism-rpc.publicnode.com",
    tokens: [
      token("0x0b2c639c533813f4aa9d7837caf62653d097ff85", "USDC", "USD Coin", 6),
      token("0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", "USDT", "Tether USD", 6),
      token("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", "DAI", "Dai Stablecoin", 18),
      token(NATIVE_TOKEN_ADDRESS, "ETH", "Ether", 18),
      token("0x4200000000000000000000000000000000000006", "WETH", "Wrapped Ether", 18),
      token("0x68f180fcCe6836688e9084f035309E29Bf0A2095", "WBTC", "Wrapped BTC", 8),
    ],
  },
  {
    id: 1,
    name: "Ethereum",
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    tokens: [
      token("0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "USDC", "USD Coin", 6),
      token("0xdAC17F958D2ee523a2206206994597C13D831ec7", "USDT", "Tether USD", 6),
      token("0x6B175474E89094C44Da98b954EedeAC495271d0F", "DAI", "Dai Stablecoin", 18),
      token(NATIVE_TOKEN_ADDRESS, "ETH", "Ether", 18),
      token("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "WETH", "Wrapped Ether", 18),
      token("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "WBTC", "Wrapped BTC", 8),
    ],
  },
  {
    id: 137,
    name: "Polygon",
    rpcUrl: "https://polygon-bor-rpc.publicnode.com",
    tokens: [
      token("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "USDC", "USD Coin", 6),
      token("0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "USDT", "Tether USD", 6),
      token("0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", "DAI", "Dai Stablecoin", 18),
      token(NATIVE_TOKEN_ADDRESS, "POL", "POL", 18),
      token("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "WETH", "Wrapped Ether", 18),
      token("0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", "WBTC", "Wrapped BTC", 8),
    ],
  },
  {
    id: 56,
    name: "BSC",
    rpcUrl: "https://bsc-rpc.publicnode.com",
    tokens: [
      token("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "USDC", "USD Coin", 18),
      token("0x55d398326f99059fF775485246999027B3197955", "USDT", "Tether USD", 18),
      token("0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", "DAI", "DAI Stablecoin", 18),
      token(NATIVE_TOKEN_ADDRESS, "BNB", "BNB", 18),
      token("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "WBNB", "Wrapped BNB", 18),
      token("0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", "BTCB", "Binance Bitcoin", 18),
    ],
  },
];

const DEFAULT_SETTINGS = {
  chainId: 8453,
  senderAddress: DEFAULT_SENDER,
  baseToken: CHAINS[0].tokens[0].address,
  quoteToken: "",
  amount: "100",
  interval: 240,
  slippageBps: 50,
  thresholdBps: 20,
  order: "CHEAPEST",
  skipSimulation: true,
};

const elements = {
  form: byId("monitor-form"),
  chain: byId("chain-select"),
  sender: byId("sender-address"),
  baseToken: byId("base-token-select"),
  quoteToken: byId("quote-token-select"),
  baseTokenAddress: byId("base-token-address"),
  quoteTokenAddress: byId("quote-token-address"),
  tokenState: byId("token-state"),
  customTokenAddress: byId("custom-token-address"),
  addCustomTokenButton: byId("add-custom-token-button"),
  customTokenMessage: byId("custom-token-message"),
  amount: byId("amount-input"),
  interval: byId("interval-input"),
  slippage: byId("slippage-input"),
  threshold: byId("threshold-input"),
  order: byId("order-select"),
  skipSimulation: byId("skip-simulation-input"),
  scanButton: byId("scan-button"),
  toggleButton: byId("toggle-button"),
  resetButton: byId("reset-button"),
  statusDot: byId("status-dot"),
  monitorStatus: byId("monitor-status"),
  quotaLabel: byId("quota-label"),
  quotaProgress: byId("quota-progress"),
  signalBadge: byId("signal-badge"),
  netProfit: byId("net-profit-value"),
  netProfitCaption: byId("net-profit-caption"),
  roi: byId("roi-value"),
  roiCaption: byId("roi-caption"),
  returnValue: byId("return-value"),
  returnCaption: byId("return-caption"),
  freshness: byId("freshness-value"),
  freshnessCaption: byId("freshness-caption"),
  lastScanTime: byId("last-scan-time"),
  routeStart: byId("route-start-token"),
  routeMiddle: byId("route-middle-token"),
  routeEnd: byId("route-end-token"),
  routeTableBody: byId("route-table-body"),
  warningBox: byId("warning-box"),
  historyTableBody: byId("history-table-body"),
  clearHistoryButton: byId("clear-history-button"),
  chart: byId("roi-chart"),
  chartEmpty: byId("chart-empty"),
  activityList: byId("activity-list"),
  clearLogButton: byId("clear-log-button"),
};

const state = {
  tokens: [],
  quoteTokens: [],
  history: readStoredArray(STORAGE_KEYS.history).slice(0, MAX_HISTORY),
  quoteCalls: readStoredArray(STORAGE_KEYS.quoteCalls),
  logs: [],
  scanning: false,
  monitoring: false,
  monitorTimer: null,
  lastScanAt: null,
};

initialize();

async function initialize() {
  removeStorage("lifi-monitor.token-cache.v1");
  populateChains();
  const settings = { ...DEFAULT_SETTINGS, ...readStoredObject(STORAGE_KEYS.settings) };
  applySettings(settings);
  await loadTokens(settings.chainId, settings.baseToken, settings.quoteToken);
  renderHistory();
  renderQuota();
  bindEvents();
  updateThresholdCaption();
  setMonitorStatus("idle", "监控已停止");
  addLog("面板已就绪。当前只进行报价观察，不会发起交易。", "info");
  window.setInterval(updateFreshness, 1000);
}

function token(address, symbol, name, decimals, priceUSD = null) {
  return { address, symbol, name, decimals, priceUSD };
}

function byId(id) {
  return document.getElementById(id);
}

function bindEvents() {
  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await scan("manual");
  });

  elements.toggleButton.addEventListener("click", async () => {
    if (state.monitoring) {
      stopMonitoring("已手动停止自动监控。");
      return;
    }
    await startMonitoring();
  });

  elements.chain.addEventListener("change", async () => {
    const chainId = Number(elements.chain.value);
    const chain = getChain(chainId);
    const preferredBase = chain?.tokens[0]?.address;
    const preferredQuote = "";
    await loadTokens(chainId, preferredBase, preferredQuote);
    clearCustomTokenForm();
    persistSettings();
    addLog(`已切换到 ${chain?.name ?? chainId}，Token 列表已更新。`, "info");
  });

  for (const input of [
    elements.sender,
    elements.baseToken,
    elements.quoteToken,
    elements.amount,
    elements.interval,
    elements.slippage,
    elements.threshold,
    elements.order,
    elements.skipSimulation,
  ]) {
    input.addEventListener("change", () => {
      persistSettings();
      if (input === elements.baseToken || input === elements.quoteToken) updateTokenDetails();
      updateThresholdCaption();
      if (state.monitoring && input === elements.interval) {
        scheduleNextScan();
      }
    });
  }

  elements.addCustomTokenButton.addEventListener("click", addCustomIntermediateToken);

  elements.resetButton.addEventListener("click", async () => {
    stopMonitoring();
    applySettings(DEFAULT_SETTINGS);
    await loadTokens(
      DEFAULT_SETTINGS.chainId,
      DEFAULT_SETTINGS.baseToken,
      DEFAULT_SETTINGS.quoteToken,
    );
    persistSettings();
    updateThresholdCaption();
    addLog("扫描配置已恢复默认值。", "info");
  });

  elements.clearHistoryButton.addEventListener("click", () => {
    state.history = [];
    writeStorage(STORAGE_KEYS.history, state.history);
    renderHistory();
    addLog("本地扫描历史已清空。", "info");
  });

  elements.clearLogButton.addEventListener("click", () => {
    state.logs = [];
    renderLogs();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.monitoring) {
      addLog("页面进入后台，后续轮询将暂缓以节省 Quote 额度。", "warning");
    } else if (!document.hidden && state.monitoring) {
      addLog("页面恢复可见，自动监控继续。", "info");
    }
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderChart, 120);
  });
}

function populateChains() {
  const fragment = document.createDocumentFragment();
  for (const chain of CHAINS) {
    const option = document.createElement("option");
    option.value = String(chain.id);
    option.textContent = `${chain.name} · ${chain.id}`;
    fragment.append(option);
  }
  elements.chain.replaceChildren(fragment);
}

function applySettings(settings) {
  elements.chain.value = String(settings.chainId);
  if (!elements.chain.value) elements.chain.value = String(DEFAULT_SETTINGS.chainId);
  elements.sender.value = settings.senderAddress || DEFAULT_SENDER;
  elements.amount.value = settings.amount ?? DEFAULT_SETTINGS.amount;
  elements.interval.value = settings.interval ?? DEFAULT_SETTINGS.interval;
  elements.slippage.value = settings.slippageBps ?? DEFAULT_SETTINGS.slippageBps;
  elements.threshold.value = settings.thresholdBps ?? DEFAULT_SETTINGS.thresholdBps;
  elements.order.value = settings.order || DEFAULT_SETTINGS.order;
  elements.skipSimulation.checked = settings.skipSimulation !== false;
}

async function loadTokens(chainId, preferredBase, preferredQuote) {
  const chain = getChain(chainId);
  if (!chain) return;

  elements.tokenState.classList.remove("error");
  const customTokens = readCustomTokens(chainId);
  populateTokenSelects(chain.tokens, customTokens, preferredBase, preferredQuote);
  elements.tokenState.textContent = customTokens.length
    ? `计价币保留 ${chain.tokens.length} 个主流资产；当前有 ${customTokens.length} 个自定义中间币。`
    : `计价币仅显示 ${chain.tokens.length} 个主流资产；请手动添加中间币后再扫描。`;
  persistSettings();
}

function mergeTokens(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const item of list) {
      if (!item?.address || !ADDRESS_PATTERN.test(item.address)) continue;
      const key = item.address.toLowerCase();
      map.set(key, { ...(map.get(key) || {}), ...item });
    }
  }

  return [...map.values()].sort((a, b) =>
    a.symbol.localeCompare(b.symbol, "en", { sensitivity: "base" }),
  );
}

function populateTokenSelects(baseTokens, quoteTokens, preferredBase, preferredQuote) {
  // Trusted base-token metadata wins when a custom token reuses a whitelist address.
  state.tokens = mergeTokens(quoteTokens, baseTokens);
  state.quoteTokens = quoteTokens;
  fillTokenSelect(elements.baseToken, baseTokens, preferredBase, baseTokens[0]?.address);
  fillTokenSelect(
    elements.quoteToken,
    quoteTokens,
    preferredQuote,
    quoteTokens[0]?.address,
    "请先手动添加中间币",
  );
  elements.quoteToken.disabled = quoteTokens.length === 0;
  updateTokenDetails();
}

function fillTokenSelect(select, tokens, preferred, fallback, emptyLabel = "暂无可用 Token") {
  const preferredKey = String(preferred || "").toLowerCase();
  const fallbackKey = String(fallback || "").toLowerCase();
  const fragment = document.createDocumentFragment();

  if (!tokens.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    option.selected = true;
    fragment.append(option);
  }

  for (const item of tokens) {
    const option = document.createElement("option");
    option.value = item.address;
    option.textContent = `${item.symbol} · ${item.name} · ${item.address}`;
    option.title = `${item.symbol} | ${item.address}`;
    fragment.append(option);
  }
  select.replaceChildren(fragment);

  const preferredToken = tokens.find((item) => item.address.toLowerCase() === preferredKey);
  const fallbackToken = tokens.find((item) => item.address.toLowerCase() === fallbackKey);
  select.value = preferredToken?.address || fallbackToken?.address || tokens[0]?.address || "";
}

function updateTokenDetails() {
  const baseToken = getSelectedToken(elements.baseToken.value);
  const quoteToken = getSelectedToken(elements.quoteToken.value);
  elements.baseTokenAddress.textContent = baseToken?.address || "—";
  elements.quoteTokenAddress.textContent = quoteToken?.address || "—";
}

async function addCustomIntermediateToken() {
  elements.customTokenMessage.classList.remove("error");
  elements.addCustomTokenButton.disabled = true;
  elements.addCustomTokenButton.textContent = "正在读取链上信息…";
  elements.customTokenAddress.disabled = true;
  elements.chain.disabled = true;

  try {
    if (state.scanning) throw new Error("当前正在扫描，请等待本轮 Quote 完成后再添加 Token");
    const chainId = Number(elements.chain.value);
    const address = elements.customTokenAddress.value.trim();
    const chain = getChain(chainId);

    if (!chain) throw new Error("请先选择支持的链");
    if (!ADDRESS_PATTERN.test(address)) throw new Error("请输入有效的 EVM Token 合约地址");
    if (address.toLowerCase() === NATIVE_TOKEN_ADDRESS) {
      throw new Error("零地址代表原生资产，不是 ERC-20 合约地址");
    }

    elements.customTokenMessage.textContent = `正在从 ${chain.name} 链读取 Token 合约信息…`;
    const metadata = await readErc20Metadata(chain, address);
    if (Number(elements.chain.value) !== chainId) throw new Error("链已切换，请重新添加 Token");
    const customToken = token(address, metadata.symbol, metadata.name, metadata.decimals);
    writeCustomToken(chainId, customToken);
    const currentBase = elements.baseToken.value;
    const customTokens = readCustomTokens(chainId);
    populateTokenSelects(chain.tokens, customTokens, currentBase, customToken.address);
    elements.tokenState.textContent = `计价币保留 ${chain.tokens.length} 个主流资产；当前有 ${customTokens.length} 个自定义中间币。`;
    persistSettings();

    elements.customTokenMessage.textContent = `已从链上读取并添加 ${customToken.symbol}（decimals ${customToken.decimals}）。`;
    addLog(`已添加自定义中间币 ${customToken.symbol}（${customToken.address}）。`, "success");
  } catch (error) {
    elements.customTokenMessage.classList.add("error");
    elements.customTokenMessage.textContent = friendlyError(error);
  } finally {
    elements.addCustomTokenButton.disabled = state.scanning;
    elements.addCustomTokenButton.textContent = "读取链上信息并添加";
    elements.customTokenAddress.disabled = state.scanning;
    elements.chain.disabled = state.scanning;
  }
}

function clearCustomTokenForm() {
  elements.customTokenAddress.value = "";
  elements.customTokenMessage.textContent = "";
  elements.customTokenMessage.classList.remove("error");
}

async function readErc20Metadata(chain, address) {
  const code = await rpcRequest(chain, "eth_getCode", [address, "latest"]);
  if (!code || code === "0x" || /^0x0*$/.test(code)) {
    throw new Error(`${chain.name} 上该地址没有合约代码`);
  }

  const [symbolResult, decimalsResult, nameResult] = await Promise.allSettled([
    callErc20View(chain, address, "0x95d89b41"),
    callErc20View(chain, address, "0x313ce567"),
    callErc20View(chain, address, "0x06fdde03"),
  ]);

  if (symbolResult.status !== "fulfilled") throw new Error("合约未返回标准 ERC-20 symbol() 数据");
  if (decimalsResult.status !== "fulfilled") throw new Error("合约未返回标准 ERC-20 decimals() 数据");

  const symbol = cleanTokenText(decodeAbiString(symbolResult.value), "", 24);
  const decimals = decodeAbiUint(decimalsResult.value);
  let name = symbol;
  if (nameResult.status === "fulfilled") {
    try {
      name = cleanTokenText(decodeAbiString(nameResult.value), symbol, 80);
    } catch {
      name = symbol;
    }
  }

  if (!symbol) throw new Error("无法从合约读取有效的 Token Symbol");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`链上 decimals 为 ${decimals}，超出页面支持的 0–36 范围`);
  }

  return { symbol, name, decimals };
}

async function callErc20View(chain, address, data) {
  return rpcRequest(chain, "eth_call", [{ to: address, data }, "latest"]);
}

async function rpcRequest(chain, method, params) {
  const response = await fetchWithTimeout(chain.rpcUrl, 15_000, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });

  if (!response.ok) throw new Error(`${chain.name} RPC 请求失败（HTTP ${response.status}）`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || `${chain.name} RPC 调用失败`);
  if (typeof payload.result !== "string") throw new Error(`${chain.name} RPC 返回了无法识别的数据`);
  return payload.result;
}

function decodeAbiUint(value) {
  if (!/^0x[0-9a-fA-F]+$/.test(value || "")) throw new Error("无法解析链上整数数据");
  return Number(BigInt(value));
}

function decodeAbiString(value) {
  const hex = String(value || "").replace(/^0x/, "");
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("无法解析链上文本数据");
  }

  if (hex.length === 64) return decodeHexText(hex.replace(/(?:00)+$/, ""));
  if (hex.length < 128) throw new Error("链上文本数据长度无效");

  const offset = Number(BigInt(`0x${hex.slice(0, 64)}`)) * 2;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 64 > hex.length) {
    throw new Error("链上文本数据偏移无效");
  }

  const byteLength = Number(BigInt(`0x${hex.slice(offset, offset + 64)}`));
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > 512) {
    throw new Error("链上文本数据长度异常");
  }

  const start = offset + 64;
  const end = start + byteLength * 2;
  if (end > hex.length) throw new Error("链上文本数据不完整");
  return decodeHexText(hex.slice(start, end));
}

function decodeHexText(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\0/g, "").trim();
}

function cleanTokenText(value, fallback, maxLength) {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (cleaned || fallback).slice(0, maxLength);
}

async function startMonitoring() {
  try {
    readAndValidateSettings();
  } catch (error) {
    showError(error);
    return;
  }

  state.monitoring = true;
  elements.toggleButton.textContent = "停止自动监控";
  elements.toggleButton.classList.add("danger");
  setMonitorStatus("running", "自动监控运行中");
  addLog("自动监控已启动。", "success");
  await scan("automatic");
  scheduleNextScan();
}

function stopMonitoring(message) {
  state.monitoring = false;
  window.clearTimeout(state.monitorTimer);
  state.monitorTimer = null;
  elements.toggleButton.textContent = "开始自动监控";
  elements.toggleButton.classList.remove("danger");
  if (!state.scanning) setMonitorStatus("idle", "监控已停止");
  if (message) addLog(message, "info");
}

function scheduleNextScan() {
  window.clearTimeout(state.monitorTimer);
  if (!state.monitoring) return;
  const intervalSeconds = Math.max(15, Number(elements.interval.value) || 240);
  state.monitorTimer = window.setTimeout(async () => {
    if (document.hidden) {
      scheduleNextScan();
      return;
    }
    await scan("automatic");
    scheduleNextScan();
  }, intervalSeconds * 1000);
}

async function scan(origin) {
  if (state.scanning) {
    addLog("上一轮扫描仍在进行，本次请求已跳过。", "warning");
    return;
  }

  let settings;
  try {
    settings = readAndValidateSettings();
    ensureQuoteBudget(2);
  } catch (error) {
    showError(error);
    if (origin === "automatic" && /额度|预算/.test(error.message)) stopMonitoring();
    return;
  }

  state.scanning = true;
  setControlsBusy(true);
  setMonitorStatus("scanning", "正在请求双向报价");
  hideWarning();
  const startedAt = Date.now();
  const chain = getChain(settings.chainId);

  try {
    const inputAmount = parseUnits(settings.amount, settings.baseToken.decimals);
    addLog(
      `开始扫描 ${chain.name}：${formatTokenAmount(inputAmount, settings.baseToken.decimals)} ${settings.baseToken.symbol} → ${settings.quoteToken.symbol} → ${settings.baseToken.symbol}。`,
      "info",
    );

    const forward = await fetchQuote({
      settings,
      fromToken: settings.baseToken,
      toToken: settings.quoteToken,
      fromAmount: inputAmount,
    });

    const reverseInput = BigInt(forward.estimate.toAmountMin);
    if (reverseInput <= 0n) throw new Error("正向 Quote 的最低到账量为零");

    const reverse = await fetchQuote({
      settings,
      fromToken: settings.quoteToken,
      toToken: settings.baseToken,
      fromAmount: reverseInput,
    });

    const result = calculateResult(settings, inputAmount, forward, reverse, startedAt);
    renderLatestResult(result);
    addHistory(result);
    state.lastScanAt = result.timestamp;
    addLog(
      result.isOpportunity
        ? `发现候选机会：预计净收益 ${result.netDisplay}，ROI ${formatBps(result.roiBps)}。`
        : `本轮无机会：预计净收益 ${result.netDisplay}，ROI ${formatBps(result.roiBps)}。`,
      result.isOpportunity ? "success" : "info",
    );
  } catch (error) {
    showError(error);
  } finally {
    state.scanning = false;
    setControlsBusy(false);
    if (state.monitoring) {
      setMonitorStatus("running", "自动监控运行中");
    } else if (!elements.statusDot.classList.contains("error")) {
      setMonitorStatus("idle", "监控已停止");
    }
    renderQuota();
  }
}

async function fetchQuote({ settings, fromToken, toToken, fromAmount }) {
  recordQuoteCall();
  const params = new URLSearchParams({
    fromChain: String(settings.chainId),
    toChain: String(settings.chainId),
    fromToken: fromToken.address,
    toToken: toToken.address,
    fromAmount: fromAmount.toString(),
    fromAddress: settings.senderAddress,
    toAddress: settings.senderAddress,
    order: settings.order,
    slippage: String(settings.slippageBps / 10_000),
  });
  if (settings.skipSimulation) params.set("skipSimulation", "true");

  const response = await fetchWithTimeout(`${API_BASE}/quote?${params.toString()}`, 25_000);
  if (!response.ok) throw await apiError(response, `${fromToken.symbol} → ${toToken.symbol} 报价失败`);
  const quote = await response.json();

  if (!quote?.estimate?.toAmountMin || !quote?.action) {
    throw new Error(`${fromToken.symbol} → ${toToken.symbol} 返回了无法识别的 Quote`);
  }
  return quote;
}

function calculateResult(settings, inputAmount, forward, reverse, startedAt) {
  const finalAmount = BigInt(reverse.estimate.toAmountMin);
  const forwardFeesUSD = sumUsd(forward.estimate.feeCosts);
  const reverseFeesUSD = sumUsd(reverse.estimate.feeCosts);
  const feeUSD = forwardFeesUSD + reverseFeesUSD;
  const gasUSD = sumUsd(forward.estimate.gasCosts) + sumUsd(reverse.estimate.gasCosts);
  const nonIncludedFeeUSD =
    sumUsd(forward.estimate.feeCosts, (item) => item.included === false) +
    sumUsd(reverse.estimate.feeCosts, (item) => item.included === false);
  const externalCostUSD = gasUSD + nonIncludedFeeUSD;
  const basePriceUSD = resolveBasePriceUSD(settings, forward, inputAmount);
  const costsConvertible = externalCostUSD === 0 || basePriceUSD > 0;
  const externalCostUnits = costsConvertible
    ? decimalNumberToUnitsUp(externalCostUSD / Math.max(basePriceUSD, Number.EPSILON), settings.baseToken.decimals)
    : 0n;
  const grossDelta = finalAmount - inputAmount;
  const netAmount = grossDelta - externalCostUnits;
  const roiBps = (Number(netAmount) / Number(inputAmount)) * 10_000;
  const isOpportunity = costsConvertible && roiBps >= settings.thresholdBps;
  const timestamp = Date.now();

  return {
    timestamp,
    durationMs: timestamp - startedAt,
    chainName: getChain(settings.chainId)?.name ?? String(settings.chainId),
    settings,
    inputAmount,
    finalAmount,
    grossDelta,
    netAmount,
    roiBps,
    isOpportunity,
    costsConvertible,
    gasUSD,
    feeUSD,
    nonIncludedFeeUSD,
    externalCostUnits,
    basePriceUSD,
    forward,
    reverse,
    inputDisplay: `${formatTokenAmount(inputAmount, settings.baseToken.decimals)} ${settings.baseToken.symbol}`,
    finalDisplay: `${formatTokenAmount(finalAmount, settings.baseToken.decimals)} ${settings.baseToken.symbol}`,
    netDisplay: `${formatSignedTokenAmount(netAmount, settings.baseToken.decimals)} ${settings.baseToken.symbol}`,
  };
}

function resolveBasePriceUSD(settings, quote, inputAmount) {
  const tokenPrice = Number(quote.action?.fromToken?.priceUSD || settings.baseToken.priceUSD || 0);
  if (Number.isFinite(tokenPrice) && tokenPrice > 0) return tokenPrice;

  const fromAmountUSD = Number(quote.estimate?.fromAmountUSD || 0);
  const humanInput = Number(formatUnitsRaw(inputAmount, settings.baseToken.decimals));
  if (fromAmountUSD > 0 && humanInput > 0) return fromAmountUSD / humanInput;
  return 0;
}

function renderLatestResult(result) {
  const { settings, forward, reverse } = result;
  const valueClass = result.netAmount >= 0n ? "positive" : "negative";

  elements.netProfit.textContent = result.netDisplay;
  elements.netProfit.className = valueClass;
  elements.netProfitCaption.textContent = result.costsConvertible
    ? `Gas ${formatUSD(result.gasUSD)} · Quote 用时 ${(result.durationMs / 1000).toFixed(1)} 秒`
    : "缺少计价币美元价格，结果尚未扣除 Gas";

  elements.roi.textContent = formatBps(result.roiBps);
  elements.roi.className = valueClass;
  elements.roiCaption.textContent = `机会阈值 ${settings.thresholdBps} bps`;

  elements.returnValue.textContent = result.finalDisplay;
  elements.returnValue.className = valueClass;
  elements.returnCaption.textContent = `两段费用合计 ${formatUSD(result.feeUSD)}`;

  elements.signalBadge.textContent = result.isOpportunity ? "候选机会" : "未达阈值";
  elements.signalBadge.className = `badge ${result.isOpportunity ? "positive" : "negative"}`;

  elements.lastScanTime.textContent = formatDateTime(result.timestamp);
  elements.routeStart.textContent = `${formatTokenAmount(result.inputAmount, settings.baseToken.decimals)} ${settings.baseToken.symbol}`;
  elements.routeMiddle.textContent = `${formatTokenAmount(BigInt(forward.estimate.toAmountMin), settings.quoteToken.decimals)} ${settings.quoteToken.symbol}`;
  elements.routeEnd.textContent = result.finalDisplay;
  renderRouteTable(result);
  renderWarnings(result);
  updateFreshness();
}

function renderRouteTable(result) {
  const rows = [
    routeRow("正向", result.forward, result.settings.baseToken, result.settings.quoteToken),
    routeRow("反向", result.reverse, result.settings.quoteToken, result.settings.baseToken),
  ];
  const fragment = document.createDocumentFragment();

  for (const row of rows) {
    const tr = document.createElement("tr");
    appendCell(tr, row.step);
    appendCell(tr, row.provider);
    appendCell(tr, row.input);
    appendCell(tr, row.output);
    appendCell(tr, row.fees);
    appendCell(tr, row.gas);
    appendCell(tr, row.duration);
    fragment.append(tr);
  }
  elements.routeTableBody.replaceChildren(fragment);
}

function routeRow(step, quote, fromToken, toToken) {
  return {
    step,
    provider: quote.toolDetails?.name || quote.tool || "—",
    input: `${formatTokenAmount(BigInt(quote.action.fromAmount), fromToken.decimals)} ${fromToken.symbol}`,
    output: `${formatTokenAmount(BigInt(quote.estimate.toAmountMin), toToken.decimals)} ${toToken.symbol}`,
    fees: formatUSD(sumUsd(quote.estimate.feeCosts)),
    gas: formatUSD(sumUsd(quote.estimate.gasCosts)),
    duration: formatDuration(Number(quote.estimate.executionDuration || 0)),
  };
}

function renderWarnings(result) {
  const warnings = ["两段 Quote 是顺序估算，不具备原子执行保证。"];
  if (result.settings.skipSimulation) warnings.push("当前开启快速报价，Gas 估算可能不精确。");
  if (!result.costsConvertible) warnings.push("LI.FI 未提供可靠的计价币美元价格，净收益没有扣除 Gas。");
  if (result.settings.interval < 192) warnings.push("当前轮询较快，持续运行可能触发公共 API 限流。");
  elements.warningBox.textContent = warnings.join(" ");
  elements.warningBox.classList.remove("hidden");
}

function hideWarning() {
  elements.warningBox.classList.add("hidden");
  elements.warningBox.textContent = "";
}

function addHistory(result) {
  state.history.unshift({
    timestamp: result.timestamp,
    chainName: result.chainName,
    pair: `${result.settings.baseToken.symbol} → ${result.settings.quoteToken.symbol} → ${result.settings.baseToken.symbol}`,
    inputDisplay: result.inputDisplay,
    finalDisplay: result.finalDisplay,
    netDisplay: result.netDisplay,
    netPositive: result.netAmount >= 0n,
    roiBps: Number.isFinite(result.roiBps) ? result.roiBps : 0,
    isOpportunity: result.isOpportunity,
  });
  state.history = state.history.slice(0, MAX_HISTORY);
  writeStorage(STORAGE_KEYS.history, state.history);
  renderHistory();
}

function renderHistory() {
  if (!state.history.length) {
    const tr = document.createElement("tr");
    tr.className = "empty-row";
    const td = document.createElement("td");
    td.colSpan = 7;
    td.textContent = "历史记录只保存在当前浏览器中";
    tr.append(td);
    elements.historyTableBody.replaceChildren(tr);
    renderChart();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of state.history) {
    const tr = document.createElement("tr");
    appendCell(tr, formatDateTime(item.timestamp));
    appendCell(tr, `${item.chainName} · ${item.pair}`);
    appendCell(tr, item.inputDisplay);
    appendCell(tr, item.finalDisplay);
    appendCell(tr, item.netDisplay, item.netPositive ? "result-positive" : "result-negative");
    appendCell(tr, formatBps(item.roiBps), item.roiBps >= 0 ? "result-positive" : "result-negative");
    appendBadgeCell(tr, item.isOpportunity ? "候选机会" : "未达阈值", item.isOpportunity ? "positive" : "neutral");
    fragment.append(tr);
  }
  elements.historyTableBody.replaceChildren(fragment);
  renderChart();
}

function renderChart() {
  const data = state.history
    .slice(0, 30)
    .reverse()
    .map((item) => Number(item.roiBps))
    .filter(Number.isFinite);

  if (data.length < 2) {
    elements.chartEmpty.classList.remove("hidden");
    const context = elements.chart.getContext("2d");
    context?.clearRect(0, 0, elements.chart.width, elements.chart.height);
    return;
  }

  elements.chartEmpty.classList.add("hidden");
  const canvas = elements.chart;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 22, right: 18, bottom: 24, left: 48 };
  const threshold = Number(elements.threshold.value) || 0;
  let min = Math.min(...data, 0, threshold);
  let max = Math.max(...data, 0, threshold);
  const range = Math.max(1, max - min);
  min -= range * 0.18;
  max += range * 0.18;

  const x = (index) => padding.left + (index / (data.length - 1)) * (width - padding.left - padding.right);
  const y = (value) => padding.top + ((max - value) / (max - min)) * (height - padding.top - padding.bottom);
  const styles = getComputedStyle(document.documentElement);
  const muted = styles.getPropertyValue("--text-muted").trim();
  const accent = styles.getPropertyValue("--accent-strong").trim();
  const positive = styles.getPropertyValue("--positive").trim();

  context.clearRect(0, 0, width, height);
  context.font = "10px system-ui";
  context.fillStyle = muted;
  context.textAlign = "right";
  context.fillText(`${max.toFixed(1)} bps`, padding.left - 7, padding.top + 3);
  context.fillText(`${min.toFixed(1)} bps`, padding.left - 7, height - padding.bottom + 3);

  drawHorizontalLine(context, y(0), padding.left, width - padding.right, muted, []);
  if (threshold !== 0) {
    drawHorizontalLine(context, y(threshold), padding.left, width - padding.right, positive, [5, 5]);
  }

  context.beginPath();
  data.forEach((value, index) => {
    if (index === 0) context.moveTo(x(index), y(value));
    else context.lineTo(x(index), y(value));
  });
  context.strokeStyle = accent;
  context.lineWidth = 2;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();

  data.forEach((value, index) => {
    context.beginPath();
    context.arc(x(index), y(value), 2.5, 0, Math.PI * 2);
    context.fillStyle = value >= threshold ? positive : accent;
    context.fill();
  });

  canvas.setAttribute(
    "aria-label",
    `最近 ${data.length} 次扫描净 ROI 走势，最新值 ${formatBps(data[data.length - 1])}`,
  );
}

function drawHorizontalLine(context, y, startX, endX, color, dash) {
  context.save();
  context.beginPath();
  context.setLineDash(dash);
  context.moveTo(startX, y);
  context.lineTo(endX, y);
  context.strokeStyle = color;
  context.globalAlpha = 0.48;
  context.lineWidth = 1;
  context.stroke();
  context.restore();
}

function readAndValidateSettings() {
  const chainId = Number(elements.chain.value);
  const baseToken = getSelectedToken(elements.baseToken.value);
  const quoteToken = getSelectedToken(elements.quoteToken.value);
  const senderAddress = elements.sender.value.trim();
  const amount = elements.amount.value.trim();
  const interval = Number(elements.interval.value);
  const slippageBps = Number(elements.slippage.value);
  const thresholdBps = Number(elements.threshold.value);

  if (!getChain(chainId)) throw new Error("请选择受支持的链");
  if (!ADDRESS_PATTERN.test(senderAddress)) throw new Error("报价地址必须是有效的 EVM 地址");
  if (!baseToken) throw new Error("请选择计价币");
  if (!quoteToken) throw new Error("请先手动添加中间币");
  if (baseToken.address.toLowerCase() === quoteToken.address.toLowerCase()) {
    throw new Error("计价币和中间币不能相同");
  }
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new Error("测试金额必须大于零");
  if (!Number.isFinite(interval) || interval < 15) throw new Error("轮询间隔不能小于 15 秒");
  if (!Number.isFinite(slippageBps) || slippageBps < 1 || slippageBps > 5000) {
    throw new Error("滑点必须介于 1 到 5000 bps");
  }
  if (!Number.isFinite(thresholdBps) || thresholdBps < 0 || thresholdBps > 10_000) {
    throw new Error("机会阈值必须介于 0 到 10000 bps");
  }

  parseUnits(amount, baseToken.decimals);
  const settings = {
    chainId,
    senderAddress,
    baseToken,
    quoteToken,
    amount,
    interval,
    slippageBps,
    thresholdBps,
    order: elements.order.value,
    skipSimulation: elements.skipSimulation.checked,
  };
  writeStorage(STORAGE_KEYS.settings, serializeSettings(settings));
  return settings;
}

function serializeSettings(settings) {
  return {
    chainId: settings.chainId,
    senderAddress: settings.senderAddress,
    baseToken: settings.baseToken.address,
    quoteToken: settings.quoteToken.address,
    amount: settings.amount,
    interval: settings.interval,
    slippageBps: settings.slippageBps,
    thresholdBps: settings.thresholdBps,
    order: settings.order,
    skipSimulation: settings.skipSimulation,
  };
}

function persistSettings() {
  const baseToken = getSelectedToken(elements.baseToken.value);
  const quoteToken = getSelectedToken(elements.quoteToken.value);
  writeStorage(STORAGE_KEYS.settings, {
    chainId: Number(elements.chain.value),
    senderAddress: elements.sender.value.trim(),
    baseToken: baseToken?.address,
    quoteToken: quoteToken?.address,
    amount: elements.amount.value,
    interval: Number(elements.interval.value),
    slippageBps: Number(elements.slippage.value),
    thresholdBps: Number(elements.threshold.value),
    order: elements.order.value,
    skipSimulation: elements.skipSimulation.checked,
  });
}

function getSelectedToken(address) {
  const key = String(address || "").toLowerCase();
  return state.tokens.find((item) => item.address.toLowerCase() === key);
}

function getChain(chainId) {
  return CHAINS.find((chain) => chain.id === Number(chainId));
}

function ensureQuoteBudget(required) {
  cleanQuoteCalls();
  if (state.quoteCalls.length + required > LOCAL_REQUEST_LIMIT) {
    throw new Error("最近两小时的本地 Quote 请求预算不足，请稍后再试");
  }
}

function recordQuoteCall() {
  cleanQuoteCalls();
  state.quoteCalls.push(Date.now());
  writeStorage(STORAGE_KEYS.quoteCalls, state.quoteCalls);
  renderQuota();
}

function cleanQuoteCalls() {
  const cutoff = Date.now() - REQUEST_WINDOW_MS;
  state.quoteCalls = state.quoteCalls.filter((timestamp) => Number(timestamp) > cutoff);
  writeStorage(STORAGE_KEYS.quoteCalls, state.quoteCalls);
}

function renderQuota() {
  cleanQuoteCalls();
  const count = state.quoteCalls.length;
  const percentage = Math.min(100, (count / LOCAL_REQUEST_LIMIT) * 100);
  elements.quotaLabel.textContent = `${count} / ${LOCAL_REQUEST_LIMIT}`;
  elements.quotaProgress.style.width = `${percentage}%`;
  elements.quotaProgress.style.backgroundColor =
    percentage >= 90 ? "var(--negative)" : percentage >= 70 ? "var(--warning)" : "var(--accent-strong)";
}

function setControlsBusy(busy) {
  elements.scanButton.disabled = busy;
  elements.scanButton.textContent = busy ? "扫描中…" : "立即扫描";
  elements.chain.disabled = busy;
  elements.baseToken.disabled = busy;
  elements.quoteToken.disabled = busy || state.quoteTokens.length === 0;
  elements.customTokenAddress.disabled = busy;
  elements.addCustomTokenButton.disabled = busy;
}

function setMonitorStatus(type, text) {
  elements.statusDot.className = "status-dot";
  if (type !== "idle") elements.statusDot.classList.add(type);
  elements.monitorStatus.textContent = text;
}

function updateThresholdCaption() {
  const threshold = Number(elements.threshold.value) || 0;
  elements.roiCaption.textContent = `机会阈值 ${threshold} bps`;
  if (state.history.length >= 2) renderChart();
}

function updateFreshness() {
  if (!state.lastScanAt) return;
  const age = Math.max(0, Math.floor((Date.now() - state.lastScanAt) / 1000));
  elements.freshness.textContent = age < 60 ? `${age} 秒` : `${Math.floor(age / 60)} 分 ${age % 60} 秒`;
  elements.freshnessCaption.textContent = age > 60 ? "报价已过期，仅供历史参考" : "Quote 通常约 60 秒内有效";
  elements.freshness.className = age > 60 ? "negative" : "positive";
}

function showError(error) {
  const message = friendlyError(error);
  setMonitorStatus("error", "扫描遇到错误");
  elements.signalBadge.textContent = "扫描失败";
  elements.signalBadge.className = "badge warning";
  elements.warningBox.textContent = message;
  elements.warningBox.classList.remove("hidden");
  addLog(message, "error");
}

function addLog(message, type = "info") {
  state.logs.unshift({ timestamp: Date.now(), message, type });
  state.logs = state.logs.slice(0, MAX_LOGS);
  renderLogs();
}

function renderLogs() {
  if (!state.logs.length) {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = "—";
    const text = document.createElement("span");
    text.textContent = "暂无活动记录。";
    li.append(time, text);
    elements.activityList.replaceChildren(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of state.logs) {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.dateTime = new Date(item.timestamp).toISOString();
    time.textContent = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(item.timestamp);
    const text = document.createElement("span");
    text.textContent = item.message;
    if (item.type === "error") text.className = "result-negative";
    if (item.type === "success") text.className = "result-positive";
    li.append(time, text);
    fragment.append(li);
  }
  elements.activityList.replaceChildren(fragment);
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: options.method || "GET",
      ...options,
      headers: { Accept: "application/json", ...(options.headers || {}) },
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请检查网络或稍后再试");
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function apiError(response, prefix) {
  let detail = "";
  try {
    const payload = await response.json();
    detail = payload.message || payload.error?.message || payload.error || "";
  } catch {
    // Ignore non-JSON error bodies.
  }

  if (response.status === 429) {
    return new Error("LI.FI Quote 请求已被限流，请等待额度窗口恢复");
  }
  return new Error(`${prefix}（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
}

function friendlyError(error) {
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return "无法连接外部接口，请检查网络、浏览器扩展或跨域策略";
  }
  return error?.message || String(error);
}

function parseUnits(value, decimals) {
  const normalized = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error("金额格式不正确");
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) throw new Error(`该 Token 最多支持 ${decimals} 位小数`);
  const scale = 10n ** BigInt(decimals);
  const fractionUnits = BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  const result = BigInt(whole) * scale + fractionUnits;
  if (result <= 0n) throw new Error("换算后的最小单位金额必须大于零");
  return result;
}

function decimalNumberToUnitsUp(value, decimals) {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  const precision = Math.min(8, decimals);
  const scaled = Math.ceil(value * 10 ** precision);
  return BigInt(scaled) * 10n ** BigInt(decimals - precision);
}

function formatUnitsRaw(value, decimals) {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function formatTokenAmount(value, decimals, precision = 6) {
  const raw = formatUnitsRaw(value, decimals);
  const number = Number(raw);
  if (!Number.isFinite(number)) return raw;
  const absolute = Math.abs(number);
  const maximumFractionDigits = absolute > 0 && absolute < 0.001 ? 10 : precision;
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits,
    useGrouping: true,
  }).format(number);
}

function formatSignedTokenAmount(value, decimals) {
  const amount = BigInt(value);
  const prefix = amount > 0n ? "+" : "";
  return `${prefix}${formatTokenAmount(amount, decimals, 8)}`;
}

function sumUsd(items, predicate = () => true) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((total, item) => {
    if (!predicate(item)) return total;
    const value = Number(item?.amountUSD || 0);
    return Number.isFinite(value) ? total + value : total;
  }, 0);
}

function formatUSD(value) {
  if (!Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.01) return `< $0.01`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatBps(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const bps = Number(value);
  const percent = bps / 100;
  const prefix = bps > 0 ? "+" : "";
  return `${prefix}${bps.toFixed(2)} bps · ${prefix}${percent.toFixed(4)}%`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function appendCell(row, text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  row.append(cell);
}

function appendBadgeCell(row, text, variant) {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `badge ${variant}`;
  badge.textContent = text;
  cell.append(badge);
  row.append(cell);
}

function readStoredObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function readStoredArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The dashboard remains functional when storage is blocked.
  }
}

function removeStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // The dashboard remains functional when storage is blocked.
  }
}

function readCustomTokens(chainId) {
  const stored = readStoredObject(STORAGE_KEYS.customTokens);
  const items = stored[String(chainId)];
  if (!Array.isArray(items)) return [];

  return items.filter(
    (item) =>
      item &&
      ADDRESS_PATTERN.test(item.address || "") &&
      item.symbol &&
      Number.isInteger(Number(item.decimals)) &&
      Number(item.decimals) >= 0 &&
      Number(item.decimals) <= 36,
  );
}

function writeCustomToken(chainId, customToken) {
  const stored = readStoredObject(STORAGE_KEYS.customTokens);
  const current = Array.isArray(stored[String(chainId)]) ? stored[String(chainId)] : [];
  stored[String(chainId)] = mergeTokens(current, [customToken]).slice(0, 50);
  writeStorage(STORAGE_KEYS.customTokens, stored);
}
