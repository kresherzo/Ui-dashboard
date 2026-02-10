import { useState, useEffect, useMemo, useCallback, useRef } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// Parse token ID to extract info
function parseTokenId(tokenId) {
  if (!tokenId) return { speaker: "?", date: "-", topic: "-", side: "?" };
  
  if (/^\d+$/.test(tokenId)) {
    return { speaker: "Unknown", date: "-", topic: tokenId.slice(0, 8) + "...", side: "?" };
  }
  
  const parts = tokenId.split("-");
  if (parts.length < 3) return { speaker: tokenId, date: "-", topic: "-", side: "?" };
  
  const prefix = parts[0];
  const speakerMatch = prefix.match(/KX(\w+?)(?:MENTION|SAY)/i);
  const speaker = speakerMatch ? speakerMatch[1] : prefix;
  
  const date = parts[1] || "-";
  const topicPart = parts.slice(2).join("-");
  const side = topicPart.endsWith("_YES") ? "YES" : topicPart.endsWith("_NO") ? "NO" : "?";
  const topic = topicPart.replace(/_YES$|_NO$/, "");
  
  return { speaker, date, topic, side };
}

// Calculate potential profit
function calculateProfit(asks, investAmount = 100) {
  if (!asks || asks.length === 0) return null;
  
  let remaining = investAmount;
  let totalShares = 0;
  
  for (const [price, qty] of asks) {
    const p = parseFloat(price);
    const q = parseFloat(qty);
    const cost = p * q;
    
    if (remaining >= cost) {
      totalShares += q;
      remaining -= cost;
    } else {
      totalShares += remaining / p;
      remaining = 0;
      break;
    }
  }
  
  // Actual amount spent (may be less than investAmount if not enough liquidity)
  const actualInvested = investAmount - remaining;
  const potentialPayout = totalShares * 1;
  const profit = potentialPayout - actualInvested;
  // ROI based on actual invested amount, not requested amount
  const roi = actualInvested > 0 ? (profit / actualInvested) * 100 : 0;
  
  return { 
    invested: investAmount, 
    actualInvested,
    shares: totalShares, 
    payout: potentialPayout, 
    profit, 
    roi,
    notEnoughLiquidity: remaining > 0
  };
}

// API hooks - basic (no auto-refresh)
function useApi(endpoint, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  const fetchData = useCallback(async () => {
    if (!endpoint) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const res = await fetch(`${API_URL}${endpoint}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [endpoint]);
  
  useEffect(() => {
    fetchData();
  }, [fetchData, ...deps]);
  
  return { data, loading, error, refetch: fetchData };
}

// API hook with auto-refresh (polling)
function useApiPolling(endpoint, intervalMs = 3000, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);
  
  const fetchData = useCallback(async (isInitial = false) => {
    if (!endpoint) {
      setLoading(false);
      return;
    }
    try {
      if (isInitial) setLoading(true);
      const res = await fetch(`${API_URL}${endpoint}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      if (isInitial) setLoading(false);
    }
  }, [endpoint]);
  
  useEffect(() => {
    fetchData(true);
    
    // Set up polling
    intervalRef.current = setInterval(() => {
      fetchData(false);
    }, intervalMs);
    
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchData, intervalMs, ...deps]);
  
  return { data, loading, error, refetch: () => fetchData(true) };
}

// Components
function StatCard({ label, value, subvalue, color = "emerald", loading }) {
  const colors = {
    emerald: "from-emerald-500/20 to-emerald-500/5 border-emerald-500/30",
    amber: "from-amber-500/20 to-amber-500/5 border-amber-500/30",
    rose: "from-rose-500/20 to-rose-500/5 border-rose-500/30",
    cyan: "from-cyan-500/20 to-cyan-500/5 border-cyan-500/30",
  };
  
  return (
    <div className={`bg-gradient-to-br ${colors[color]} border rounded-xl p-4`}>
      <div className="text-xs uppercase tracking-wider text-slate-400 mb-1">{label}</div>
      {loading ? (
        <div className="h-8 bg-slate-700/50 rounded animate-pulse" />
      ) : (
        <>
          <div className="text-2xl font-bold text-white font-mono">{value?.toLocaleString?.() ?? value}</div>
          {subvalue && <div className="text-xs text-slate-500 mt-1 truncate">{subvalue}</div>}
        </>
      )}
    </div>
  );
}

function TokensTable({ onSelect, selectedToken, hideUnknown, setHideUnknown }) {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("count");
  
  // Auto-refresh every 3 seconds
  const { data, loading, error } = useApiPolling(`/api/tokens?limit=500&sort_by=${sortBy}${search ? `&search=${search}` : ''}`, 3000);
  
  const tokens = useMemo(() => {
    if (!data?.tokens) return [];
    let items = data.tokens.map(t => ({
      ...t,
      ...parseTokenId(t.id)
    }));
    
    if (hideUnknown) {
      items = items.filter(t => t.speaker !== "Unknown");
    }
    
    return items;
  }, [data, hideUnknown]);
  
  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-2 mb-3">
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
        />
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          className="bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-cyan-500/50"
        >
          <option value="count">Count</option>
          <option value="name">Name</option>
        </select>
      </div>
      
      <label className="flex items-center gap-2 mb-3 cursor-pointer">
        <input
          type="checkbox"
          checked={hideUnknown}
          onChange={e => setHideUnknown(e.target.checked)}
          className="w-4 h-4 rounded bg-slate-700 border-slate-600"
        />
        <span className="text-xs text-slate-400">Hide numeric IDs</span>
      </label>
      
      {error && (
        <div className="p-3 bg-rose-500/20 border border-rose-500/30 rounded-lg text-rose-400 text-sm mb-3">
          {error}
        </div>
      )}
      
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="space-y-2">
            {[...Array(10)].map((_, i) => (
              <div key={i} className="h-10 bg-slate-800/30 rounded animate-pulse" />
            ))}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-900/95 backdrop-blur">
              <tr className="text-slate-400 text-xs uppercase tracking-wider">
                <th className="text-left py-2 px-2">Token ID</th>
                <th className="text-center py-2 px-2">Side</th>
                <th className="text-right py-2 px-2">Count</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map(token => (
                <tr 
                  key={token.id}
                  onClick={() => onSelect(token.id)}
                  className={`border-b border-slate-800/50 cursor-pointer transition-colors ${
                    selectedToken === token.id 
                      ? "bg-cyan-500/10" 
                      : "hover:bg-slate-800/30"
                  }`}
                >
                  <td className="py-2 px-2">
                    <span className="text-cyan-400 font-medium text-xs break-all">{token.id}</span>
                  </td>
                  <td className="py-2 px-2 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                      token.side === "YES" ? "bg-emerald-500/20 text-emerald-400" :
                      token.side === "NO" ? "bg-rose-500/20 text-rose-400" :
                      "bg-slate-500/20 text-slate-400"
                    }`}>
                      {token.side}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right">
                    <span className={`font-mono font-bold ${
                      token.count >= 10 ? "text-amber-400" :
                      token.count >= 5 ? "text-emerald-400" :
                      "text-slate-400"
                    }`}>
                      {token.count}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="text-xs text-slate-500 mt-2">
        Showing {tokens.length} tokens
      </div>
    </div>
  );
}

function OrderbookView({ tokenId, investAmount, setInvestAmount }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [targetPrice, setTargetPrice] = useState('');
  const { data, loading, error } = useApi(tokenId ? `/api/orderbook/${encodeURIComponent(tokenId)}?history=100` : null, [tokenId]);
  const { data: bestPriceData } = useApi(tokenId ? `/api/orderbook/${encodeURIComponent(tokenId)}/best-price` : null, [tokenId]);
  const { data: targetPriceData } = useApi(
    tokenId && targetPrice ? `/api/orderbook/${encodeURIComponent(tokenId)}/best-price?target_price=${targetPrice}` : null, 
    [tokenId, targetPrice]
  );
  
  // Reset index when token changes
  useEffect(() => {
    setCurrentIndex(0);
    setTargetPrice('');
  }, [tokenId]);
  
  if (!tokenId) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500">
        ← Select a token to view orderbook
      </div>
    );
  }
  
  if (loading) {
    return <div className="animate-pulse bg-slate-800/30 h-full rounded" />;
  }
  
  if (error) {
    return (
      <div className="p-4 bg-rose-500/20 border border-rose-500/30 rounded-lg text-rose-400">
        {error === "HTTP 404" ? "No orderbook for this token" : `Error: ${error}`}
      </div>
    );
  }
  
  const snapshots = data?.snapshots || [];
  const totalSnapshots = data?.total_snapshots || snapshots.length;
  
  if (snapshots.length === 0) {
    return <div className="text-slate-500">No orderbook data</div>;
  }
  
  const orderbook = snapshots[currentIndex];
  const asks = orderbook?.asks || [];
  const bids = orderbook?.bids || [];
  const profit = calculateProfit(asks, investAmount);
  
  // Navigation: index 0 = newest, index max = oldest
  const goNewer = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  };
  
  const goOlder = () => {
    if (currentIndex < snapshots.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  };
  
  const goNewest = () => setCurrentIndex(0);
  const goOldest = () => setCurrentIndex(snapshots.length - 1);
  
  // Format time ago (timestamp is in seconds, Date.now() is in milliseconds)
  const formatTimeAgo = (timestamp) => {
    if (!timestamp) return "-";
    const now = Date.now();
    const timestampMs = timestamp * 1000;
    const diff = now - timestampMs;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return "just now";
  };
  
  return (
    <div className="space-y-4">
      {/* Token ID Header */}
      <div>
        <h3 className="text-sm font-bold text-cyan-400 break-all">{tokenId}</h3>
      </div>
      
      {/* Timeline Navigation */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
        <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Timeline Navigation</div>
        
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              onClick={goOldest}
              disabled={currentIndex >= snapshots.length - 1}
              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 rounded text-xs"
              title="Oldest"
            >
              ««
            </button>
            <button
              onClick={goOlder}
              disabled={currentIndex >= snapshots.length - 1}
              className="px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 rounded text-sm"
              title="Older"
            >
              ← Older
            </button>
          </div>
          
          <div className="text-center">
            <div className="text-sm font-mono text-white">
              {currentIndex + 1} / {snapshots.length}
            </div>
            <div className="text-xs text-slate-500">
              {totalSnapshots > snapshots.length && `(${totalSnapshots} total)`}
            </div>
          </div>
          
          <div className="flex items-center gap-1">
            <button
              onClick={goNewer}
              disabled={currentIndex === 0}
              className="px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 rounded text-sm"
              title="Newer"
            >
              Newer →
            </button>
            <button
              onClick={goNewest}
              disabled={currentIndex === 0}
              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 rounded text-xs"
              title="Last (newest)"
            >
              »»
            </button>
          </div>
        </div>
        
        {/* Slider */}
        {snapshots.length > 1 && (
          <div className="mt-3">
            <input
              type="range"
              min="0"
              max={snapshots.length - 1}
              value={snapshots.length - 1 - currentIndex}
              onChange={(e) => setCurrentIndex(snapshots.length - 1 - parseInt(e.target.value))}
              className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
            />
            <div className="flex justify-between text-xs text-slate-500 mt-1">
              <span>Oldest</span>
              <span>Newest</span>
            </div>
          </div>
        )}
        
        <div className="text-xs text-slate-500 mt-2 text-center font-mono">
          {orderbook?.timestamp ? (
            <>
              {new Date(orderbook.timestamp).toLocaleString()}
              <span className="text-slate-600 ml-2">({orderbook.timestamp}ms)</span>
            </>
          ) : '-'}
        </div>
      </div>
      
      {/* Price History */}
      <div className="bg-gradient-to-br from-amber-500/10 to-orange-500/10 border border-amber-500/20 rounded-lg p-3">
        <div className="text-xs uppercase tracking-wider text-slate-400 mb-3">Price History</div>
        
        {bestPriceData?.best_price && bestPriceData?.current_price ? (
          <>
            {/* Current vs Best */}
            <div className="flex items-center gap-3 mb-3">
              <div className="text-center min-w-[70px]">
                <div className="text-lg font-bold text-emerald-400 font-mono">${bestPriceData.best_price}</div>
                <div className="text-xs text-slate-500">best</div>
                <div className="text-xs text-slate-600">{formatTimeAgo(bestPriceData.best_timestamp)}</div>
              </div>
              
              <div className="flex-1">
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div 
                    className={`h-full rounded-full transition-all duration-500 ${
                      bestPriceData.difference > 0 
                        ? 'bg-gradient-to-r from-emerald-500 to-rose-500' 
                        : 'bg-emerald-500'
                    }`}
                    style={{ width: bestPriceData.difference > 0 ? '100%' : '30%' }}
                  />
                </div>
              </div>
              
              <div className="text-center min-w-[70px]">
                <div className={`text-lg font-bold font-mono ${bestPriceData.difference > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                  ${bestPriceData.current_price}
                </div>
                <div className="text-xs text-slate-500">now</div>
                {bestPriceData.difference > 0 && (
                  <div className="text-xs text-rose-400">+${bestPriceData.difference?.toFixed(2)}</div>
                )}
              </div>
            </div>
            
            {/* Search by target price */}
            <div className="border-t border-slate-700 pt-3 mt-3">
              <div className="flex items-center gap-2 mb-2">
                <label className="text-xs text-slate-400">Find when price was ≤</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={targetPrice}
                  onChange={e => setTargetPrice(e.target.value)}
                  placeholder="0.85"
                  className="w-20 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-white font-mono text-center focus:outline-none focus:border-amber-500"
                />
              </div>
              
              {targetPrice && targetPriceData && (
                <div className="text-sm">
                  {targetPriceData.target_found ? (
                    <div className="text-emerald-400">
                      ✓ Price was <span className="font-mono font-bold">${targetPriceData.target_found_price}</span>
                      {' '}<span className="text-slate-400">{formatTimeAgo(targetPriceData.target_found_timestamp)}</span>
                    </div>
                  ) : (
                    <div className="text-rose-400">
                      ✗ Price was never ≤ ${targetPrice} in history
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="text-sm text-slate-500">No price data available</div>
        )}
      </div>
      
      {/* Profit Calculator */}
      <div className="bg-gradient-to-br from-emerald-500/10 to-cyan-500/10 border border-emerald-500/20 rounded-xl p-4">
        <div className="text-xs uppercase tracking-wider text-slate-400 mb-3">Profit Calculator</div>
        <div className="flex items-center gap-4 mb-4">
          <label className="text-sm text-slate-400">Invest $</label>
          <input
            type="number"
            value={investAmount}
            onChange={e => setInvestAmount(Number(e.target.value))}
            className="w-24 bg-slate-800 border border-slate-600 rounded px-3 py-1 text-white font-mono text-right focus:outline-none focus:border-cyan-500"
          />
        </div>
        {profit && (
          <>
            {profit.notEnoughLiquidity && (
              <div className="mb-3 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
                ⚠️ Not enough liquidity. Only ${profit.actualInvested.toFixed(2)} can be spent.
              </div>
            )}
            <div className="grid grid-cols-4 gap-3 text-center">
              <div>
                <div className="text-xs text-slate-500">Shares</div>
                <div className="text-lg font-bold text-white font-mono">{profit.shares.toFixed(0)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">If Wins</div>
                <div className="text-lg font-bold text-emerald-400 font-mono">${profit.payout.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Profit</div>
                <div className={`text-lg font-bold font-mono ${profit.profit >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {profit.profit >= 0 ? "+" : ""}${profit.profit.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">ROI</div>
                <div className={`text-lg font-bold font-mono ${profit.roi >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {profit.roi >= 0 ? "+" : ""}{profit.roi.toFixed(0)}%
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      
      {/* Orderbook */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-rose-400 mb-2 flex justify-between">
            <span>Asks (Sell)</span>
            <span>{asks.reduce((s, [,q]) => s + parseFloat(q), 0).toLocaleString()}</span>
          </div>
          <div className="space-y-1 max-h-40 overflow-auto flex flex-col-reverse">
            {asks.length === 0 ? (
              <div className="text-slate-500 text-sm italic">No asks</div>
            ) : asks.slice(0, 15).map(([price, qty], i) => {
              const maxQty = Math.max(...asks.map(([,q]) => parseFloat(q)));
              const pct = (parseFloat(qty) / maxQty) * 100;
              return (
                <div key={i} className="relative">
                  <div className="absolute inset-0 bg-rose-500/20 rounded" style={{ width: `${pct}%` }} />
                  <div className="relative flex justify-between px-2 py-0.5 text-sm font-mono">
                    <span className="text-rose-400">${price}</span>
                    <span className="text-slate-300">{parseInt(qty).toLocaleString()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        
        <div>
          <div className="text-xs uppercase tracking-wider text-emerald-400 mb-2 flex justify-between">
            <span>Bids (Buy)</span>
            <span>{bids.reduce((s, [,q]) => s + parseFloat(q), 0).toLocaleString()}</span>
          </div>
          <div className="space-y-1 max-h-40 overflow-auto">
            {bids.length === 0 ? (
              <div className="text-slate-500 text-sm italic">No bids</div>
            ) : bids.slice(0, 15).map(([price, qty], i) => {
              const maxQty = Math.max(...bids.map(([,q]) => parseFloat(q)));
              const pct = (parseFloat(qty) / maxQty) * 100;
              return (
                <div key={i} className="relative">
                  <div className="absolute inset-0 bg-emerald-500/20 rounded" style={{ width: `${pct}%` }} />
                  <div className="relative flex justify-between px-2 py-0.5 text-sm font-mono">
                    <span className="text-emerald-400">${price}</span>
                    <span className="text-slate-300">{parseInt(qty).toLocaleString()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function LiveFeed() {
  // Auto-refresh every 2 seconds for live feel
  const { data, loading } = useApiPolling('/api/stream/history?count=30', 2000);
  
  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-12 bg-slate-800/30 rounded animate-pulse" />
        ))}
      </div>
    );
  }
  
  const updates = data?.updates || [];
  
  return (
    <div className="space-y-1">
      {updates.map(update => {
        const { speaker, topic } = parseTokenId(update.token_id);
        return (
          <div 
            key={update.id}
            className="flex items-center gap-2 p-2 bg-slate-800/30 rounded-lg border border-slate-700/50"
          >
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
            <div className="flex-1 min-w-0 text-sm">
              <span className="text-cyan-400 font-medium">{speaker}</span>
              <span className="text-slate-500 mx-1">→</span>
              <span className="text-amber-400">{topic}</span>
            </div>
            <div className="text-xs text-slate-500 font-mono flex-shrink-0">
              +{update.count}
            </div>
          </div>
        );
      })}
      {updates.length === 0 && (
        <div className="text-slate-500 text-sm text-center py-4">No updates</div>
      )}
    </div>
  );
}

// Stream Races - compare detection speed across containers
function StreamRaces() {
  const { data: racesData, loading: racesLoading } = useApiPolling('/api/stream/races?count=1000', 5000);
  const { data: statsData, loading: statsLoading } = useApiPolling('/api/stream/container-stats?count=2000', 5000);
  
  const races = racesData?.races || [];
  const containers = statsData?.containers || [];
  
  const formatTime = (timestamp) => {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    const hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const hours12 = hours % 12 || 12;
    return `${hours12}:${minutes}:${seconds}.${ms} ${ampm}`;
  };
  
  const formatDateTime = (timestamp) => {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    const hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const hours12 = hours % 12 || 12;
    const dateStr = date.toLocaleDateString();
    return `${dateStr} ${hours12}:${minutes}:${seconds}.${ms} ${ampm}`;
  };
  
  const formatTimeAgo = (timestamp) => {
    if (!timestamp) return '-';
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
  };
  
  // Format diff_ms - always show milliseconds
  const formatDiff = (ms) => {
    const num = Number(ms) || 0;
    if (num === 0) return '0ms';
    return `+${Math.round(num)}ms`;
  };
  
  // Calculate win stats per container
  const winStats = {};
  races.forEach(race => {
    const winner = race.winner;
    if (!winStats[winner]) {
      winStats[winner] = { wins: 0, total: 0, avgDiff: 0, diffs: [] };
    }
    winStats[winner].wins++;
    
    race.results.forEach(r => {
      if (!winStats[r.container_id]) {
        winStats[r.container_id] = { wins: 0, total: 0, avgDiff: 0, diffs: [] };
      }
      winStats[r.container_id].total++;
      if (r.diff_ms > 0) {
        winStats[r.container_id].diffs.push(r.diff_ms);
      }
    });
  });
  
  // Calculate average diff for each container
  Object.keys(winStats).forEach(key => {
    const diffs = winStats[key].diffs;
    if (diffs.length > 0) {
      winStats[key].avgDiff = Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length);
    }
  });
  
  return (
    <div className="space-y-4">
      {/* Container Stats */}
      <div className="grid grid-cols-4 gap-4">
        {containers.slice(0, 4).map(container => (
          <div key={container.container_id} className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Container</div>
            <div className="text-lg font-bold text-cyan-400 truncate" title={container.container_id}>
              {container.container_id}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <div>
                <div className="text-slate-500 text-xs">Detections</div>
                <div className="font-mono text-white">{container.detections}</div>
              </div>
              <div>
                <div className="text-slate-500 text-xs">Tokens</div>
                <div className="font-mono text-white">{container.unique_tokens}</div>
              </div>
              <div>
                <div className="text-slate-500 text-xs">Wins</div>
                <div className="font-mono text-emerald-400">
                  {winStats[container.container_id]?.wins || 0}
                </div>
              </div>
              <div>
                <div className="text-slate-500 text-xs">Avg Delay</div>
                <div className="font-mono text-amber-400 text-xs">
                  {winStats[container.container_id]?.avgDiff 
                    ? formatDiff(winStats[container.container_id].avgDiff)
                    : '-'}
                </div>
              </div>
            </div>
          </div>
        ))}
        {containers.length === 0 && !statsLoading && (
          <div className="col-span-4 text-center text-slate-500 py-8">
            No containers found. Start ASR modules to see stats.
          </div>
        )}
      </div>
      
      {/* Races */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
        <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4">
          Detection Races ({races.length})
        </h2>
        
        {races.length === 0 && !racesLoading && (
          <div className="text-center text-slate-500 py-8">
            No races found. Races appear when multiple containers detect the same token.
          </div>
        )}
        
        <div className="space-y-4 max-h-[calc(100vh-350px)] overflow-auto">
          {races.map((race, idx) => {
            const maxDiff = Math.max(...race.results.map(r => r.diff_ms), 1);
            
            return (
              <div key={idx} className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-bold text-amber-400 truncate flex-1" title={race.token_id}>
                    {race.token_id}
                  </div>
                  <div className="text-xs text-slate-500 ml-2 flex items-center gap-2">
                    <span>Count #{race.count}</span>
                    <span>•</span>
                    <span>{race.participants} participants</span>
                    {race.time_spread_ms > 0 && (
                      <>
                        <span>•</span>
                        <span className="text-rose-400">Spread: {formatDiff(race.time_spread_ms)}</span>
                      </>
                    )}
                  </div>
                </div>
                
                <div className="space-y-1">
                  {race.results.map((result, i) => {
                    const medals = ['🥇', '🥈', '🥉'];
                    const medal = medals[i] || `${i + 1}.`;
                    // Bar width based on relative delay (fastest = 100%, slowest = 20%)
                    const barWidth = result.is_fastest 
                      ? 100 
                      : Math.max(20, 100 - (result.diff_ms / maxDiff) * 80);
                    
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <span className="w-6 text-center flex-shrink-0">{medal}</span>
                        <span 
                          className={`w-64 flex-shrink-0 text-sm font-mono overflow-hidden text-ellipsis whitespace-nowrap ${result.is_fastest ? 'text-emerald-400' : 'text-slate-400'}`}
                          style={{direction: 'rtl', textAlign: 'left'}}
                          title={result.container_id}
                        >
                          {result.container_id}
                        </span>
                        <span className="w-32 text-xs text-slate-500 font-mono flex-shrink-0" title={formatDateTime(result.timestamp)}>
                          {formatTime(result.timestamp)}
                        </span>
                        <div className="flex-1 h-6 bg-slate-700 rounded overflow-hidden relative min-w-[200px]">
                          <div 
                            className={`h-full rounded transition-all ${
                              result.is_fastest 
                                ? 'bg-gradient-to-r from-emerald-500 to-emerald-400' 
                                : result.diff_ms > 10000 
                                  ? 'bg-gradient-to-r from-rose-600 to-rose-500'
                                  : result.diff_ms > 1000
                                    ? 'bg-gradient-to-r from-amber-600 to-amber-500'
                                    : 'bg-gradient-to-r from-slate-500 to-slate-400'
                            }`}
                            style={{ width: `${barWidth}%` }}
                          />
                          {/* Diff text inside bar */}
                          <span className={`absolute inset-0 flex items-center justify-end pr-3 text-xs font-mono font-bold ${
                            result.is_fastest ? 'text-white' : 'text-white/80'
                          }`}>
                            {result.is_fastest ? '⚡ fastest' : formatDiff(result.diff_ms)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ModuleLauncher() {
  const [config, setConfig] = useState({
    name: "asr-module",
    input: "",
    words: "",
    reference: "",
    similarity_threshold: 0.70,
    format: "bestaudio/best[height<=360]/worst",
    downloader: "",
    monitor_interval: 5,
    hls_interval: 0.1,
    chunk_size_ms: 5000,
    print_transcript: false,
    first_therm: false,
    autostart: false,
    verbose: false,
    no_hls_skip: false,
    simulate_realtime: false,
    use_fc: false,
  });
  
  // Portainer settings - load from localStorage
  const [portainerConfig, setPortainerConfig] = useState(() => {
    const saved = localStorage.getItem('portainer_config');
    return saved ? JSON.parse(saved) : {
      url: "http://localhost:9000",
      token: "",
      endpoint_id: 1,
      image: "asr-module:latest",
      volumes_path: "",  // Path on host with tokens/, reference_voices/, cookies/
      redis_host: "redis",   // Redis host for ASR container
      redis_port: "6379",    // Redis port for ASR container
      network_mode: "asr-network"  // asr-network for local, host for external
    };
  });
  
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPortainerSettings, setShowPortainerSettings] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [launchResult, setLaunchResult] = useState(null);
  const [copiedDocker, setCopiedDocker] = useState(false);
  const [copiedScript, setCopiedScript] = useState(false);
  const [portainerConnected, setPortainerConnected] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [portainerContainers, setPortainerContainers] = useState([]);
  
  // Save Portainer config to localStorage
  useEffect(() => {
    localStorage.setItem('portainer_config', JSON.stringify(portainerConfig));
  }, [portainerConfig]);
  
  // Test Portainer connection
  const testPortainerConnection = async () => {
    setTestingConnection(true);
    try {
      const res = await fetch(`${API_URL}/api/portainer/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portainer_url: portainerConfig.url,
          api_token: portainerConfig.token,
          endpoint_id: portainerConfig.endpoint_id
        })
      });
      const data = await res.json();
      if (data.status === 'success') {
        setPortainerConnected(true);
        setLaunchResult({ status: 'success', message: data.message });
        // Fetch containers
        fetchPortainerContainers();
      } else {
        setPortainerConnected(false);
        setLaunchResult({ status: 'error', message: data.message });
      }
    } catch (err) {
      setPortainerConnected(false);
      setLaunchResult({ status: 'error', message: err.message });
    } finally {
      setTestingConnection(false);
    }
  };
  
  // Fetch containers from Portainer
  const fetchPortainerContainers = async () => {
    try {
      const res = await fetch(
        `${API_URL}/api/portainer/containers?portainer_url=${encodeURIComponent(portainerConfig.url)}&api_token=${encodeURIComponent(portainerConfig.token)}&endpoint_id=${portainerConfig.endpoint_id}`
      );
      const data = await res.json();
      if (data.status === 'success') {
        setPortainerContainers(data.containers || []);
      }
    } catch (err) {
      console.error('Failed to fetch containers:', err);
    }
  };
  
  // Build run_module.sh command (original format)
  const buildScriptCommand = () => {
    const parts = ["./run_module.sh"];
    
    if (config.name && config.name !== "asr-module") {
      parts.push(`--name ${config.name}`);
    }
    
    parts.push("--");
    
    if (config.words) parts.push(`--words ${config.words}`);
    if (config.reference) parts.push(`--reference ${config.reference}`);
    
    if (config.similarity_threshold !== 0.70) {
      parts.push(`--similarity_threshold ${config.similarity_threshold}`);
    }
    if (config.format && config.format !== "bestaudio/best[height<=360]/worst") {
      parts.push(`--format "${config.format}"`);
    }
    if (config.downloader) {
      parts.push(`--downloader ${config.downloader}`);
    }
    if (config.monitor_interval !== 5) {
      parts.push(`--monitor-interval ${config.monitor_interval}`);
    }
    if (config.hls_interval !== 0.1) {
      parts.push(`--hls-interval ${config.hls_interval}`);
    }
    if (config.chunk_size_ms !== 5000) {
      parts.push(`--chunk-size-ms ${config.chunk_size_ms}`);
    }
    
    if (config.print_transcript) parts.push("--print-transcript");
    if (config.first_therm) parts.push("--first-therm");
    if (config.autostart) parts.push("--autostart");
    if (config.verbose) parts.push("--verbose");
    if (config.no_hls_skip) parts.push("--no-hls-skip");
    if (config.simulate_realtime) parts.push("--simulate-realtime");
    if (config.use_fc) parts.push("--use-fc");
    
    if (config.input) {
      parts.push(`"${config.input}"`);
    }
    
    return parts.join(" ");
  };
  
  // Build docker run command
  const buildDockerCommand = () => {
    const parts = ["docker", "run", "-d"];
    parts.push(`--name ${config.name}`);
    parts.push("--network asr-network");
    parts.push("-e REDIS_HOST=redis");
    parts.push("-e REDIS_PORT=6379");
    parts.push("asr-module:latest");
    
    if (config.words) parts.push(`--words ${config.words}`);
    if (config.reference) parts.push(`--reference ${config.reference}`);
    
    if (config.similarity_threshold !== 0.70) {
      parts.push(`--similarity_threshold ${config.similarity_threshold}`);
    }
    if (config.format && config.format !== "bestaudio/best[height<=360]/worst") {
      parts.push(`--format "${config.format}"`);
    }
    if (config.downloader) {
      parts.push(`--downloader ${config.downloader}`);
    }
    if (config.monitor_interval !== 5) {
      parts.push(`--monitor-interval ${config.monitor_interval}`);
    }
    if (config.hls_interval !== 0.1) {
      parts.push(`--hls-interval ${config.hls_interval}`);
    }
    if (config.chunk_size_ms !== 5000) {
      parts.push(`--chunk-size-ms ${config.chunk_size_ms}`);
    }
    
    if (config.print_transcript) parts.push("--print-transcript");
    if (config.first_therm) parts.push("--first-therm");
    if (config.autostart) parts.push("--autostart");
    if (config.verbose) parts.push("--verbose");
    if (config.no_hls_skip) parts.push("--no-hls-skip");
    if (config.simulate_realtime) parts.push("--simulate-realtime");
    if (config.use_fc) parts.push("--use-fc");
    
    if (config.input) {
      parts.push(`"${config.input}"`);
    }
    
    return parts.join(" \\\n  ");
  };
  
  const scriptCommand = buildScriptCommand();
  const dockerCommand = buildDockerCommand();
  
  const copyDockerCommand = () => {
    navigator.clipboard.writeText(dockerCommand.replace(/\\\n\s+/g, " "));
    setCopiedDocker(true);
    setTimeout(() => setCopiedDocker(false), 2000);
  };
  
  const copyScriptCommand = () => {
    navigator.clipboard.writeText(scriptCommand);
    setCopiedScript(true);
    setTimeout(() => setCopiedScript(false), 2000);
  };
  
  const handleLaunch = async () => {
    setLaunching(true);
    setLaunchResult(null);
    
    try {
      // Check Portainer is configured
      if (!portainerConfig.token) {
        setLaunchResult({ status: 'error', message: 'Configure Portainer settings first!' });
        setShowPortainerSettings(true);
        setLaunching(false);
        return;
      }
      
      // Build command arguments from form
      const cmdArgs = [];
      if (config.words) cmdArgs.push("--words", config.words);
      if (config.reference) cmdArgs.push("--reference", config.reference);
      if (config.similarity_threshold && config.similarity_threshold !== 0.70) {
        cmdArgs.push("--similarity_threshold", String(config.similarity_threshold));
      }
      if (config.print_transcript) cmdArgs.push("--print-transcript");
      if (config.autostart) cmdArgs.push("--autostart");
      if (config.verbose) cmdArgs.push("--verbose");
      
      // Advanced settings
      if (config.first_therm) cmdArgs.push("--first-therm");
      if (config.no_hls_skip) cmdArgs.push("--no-hls-skip");
      if (config.simulate_realtime) cmdArgs.push("--simulate-realtime");
      if (config.use_fc) cmdArgs.push("--use-fc");
      if (config.monitor_interval && config.monitor_interval !== 5) {
        cmdArgs.push("--monitor-interval", String(config.monitor_interval));
      }
      if (config.hls_interval && config.hls_interval !== 0.1) {
        cmdArgs.push("--hls-interval", String(config.hls_interval));
      }
      if (config.chunk_size_ms && config.chunk_size_ms !== 5000) {
        cmdArgs.push("--chunk-size-ms", String(config.chunk_size_ms));
      }
      if (config.downloader && config.downloader !== '' && config.downloader !== 'auto') {
        cmdArgs.push("--downloader", config.downloader);
      }
      if (config.format && config.format !== 'bestaudio/best[height<=360]/worst') {
        cmdArgs.push("--format", config.format);
      }
      
      // Add stream URL at the end
      if (config.input) cmdArgs.push(config.input);
      
      // Build volumes mapping (if path specified)
      const volumes = {};
      if (portainerConfig.volumes_path) {
        const basePath = portainerConfig.volumes_path.replace(/\/$/, '');
        volumes[`${basePath}/tokens`] = "/app/tokens";
        volumes[`${basePath}/reference_voices`] = "/app/reference_voices";
        volumes[`${basePath}/cookies`] = "/app/cookies";
      }
      
      const res = await fetch(`${API_URL}/api/portainer/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portainer_url: portainerConfig.url,
          api_token: portainerConfig.token,
          endpoint_id: portainerConfig.endpoint_id,
          container_name: config.name,
          image: portainerConfig.image,
          network_mode: portainerConfig.network_mode || "asr-network",
          environment: {
            "REDIS_HOST": portainerConfig.redis_host || "redis",
            "REDIS_PORT": portainerConfig.redis_port || "6379",
            "CONTAINER_NAME": config.name
          },
          command: cmdArgs,
          volumes: volumes
        })
      });
      const data = await res.json();
      setLaunchResult(data);
      if (data.status === 'success') {
        fetchPortainerContainers();
      }
    } catch (err) {
      setLaunchResult({
        status: 'error',
        message: 'Network error: ' + err.message
      });
    } finally {
      setLaunching(false);
    }
  };
  
  const handleStop = async (containerName) => {
    setStopping(true);
    try {
      const res = await fetch(
        `${API_URL}/api/portainer/stop/${containerName}?portainer_url=${encodeURIComponent(portainerConfig.url)}&api_token=${encodeURIComponent(portainerConfig.token)}&endpoint_id=${portainerConfig.endpoint_id}`,
        { method: 'POST' }
      );
      const data = await res.json();
      setLaunchResult(data);
      fetchPortainerContainers();
    } catch (err) {
      setLaunchResult({ status: 'error', message: err.message });
    } finally {
      setStopping(false);
    }
  };
  
  return (
    <div className="space-y-6">
      {/* Portainer Settings */}
      <div className="bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20 rounded-xl p-4">
        <button
          onClick={() => setShowPortainerSettings(!showPortainerSettings)}
          className="flex items-center justify-between w-full"
        >
          <div className="flex items-center gap-2">
            <span className="text-lg">🐳</span>
            <span className="text-sm font-bold text-blue-400">Portainer Settings</span>
            {portainerConnected && <span className="text-xs text-emerald-400">● Connected</span>}
          </div>
          <span className="text-slate-400">{showPortainerSettings ? '▼' : '▶'}</span>
        </button>
        
        {showPortainerSettings && (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Portainer URL</label>
                <input
                  type="text"
                  value={portainerConfig.url}
                  onChange={e => setPortainerConfig({...portainerConfig, url: e.target.value})}
                  placeholder="http://localhost:9000"
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Endpoint ID</label>
                <input
                  type="number"
                  value={portainerConfig.endpoint_id}
                  onChange={e => setPortainerConfig({...portainerConfig, endpoint_id: parseInt(e.target.value) || 1})}
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50"
                />
              </div>
            </div>
            
            <div>
              <label className="text-xs text-slate-400 block mb-1">API Token</label>
              <input
                type="password"
                value={portainerConfig.token}
                onChange={e => setPortainerConfig({...portainerConfig, token: e.target.value})}
                placeholder="ptr_xxxxx..."
                className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50"
              />
            </div>
            
            <div>
              <label className="text-xs text-slate-400 block mb-1">ASR Image Name</label>
              <input
                type="text"
                value={portainerConfig.image}
                onChange={e => setPortainerConfig({...portainerConfig, image: e.target.value})}
                placeholder="asr-module:latest"
                className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Volumes Path (host)</label>
                <input
                  type="text"
                  value={portainerConfig.volumes_path || ''}
                  onChange={e => setPortainerConfig({...portainerConfig, volumes_path: e.target.value})}
                  placeholder="/home/user/asr-data"
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50"
                />
                <div className="text-xs text-slate-500 mt-1">Path with tokens/, reference_voices/, cookies/</div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Network Mode</label>
                <select
                  value={portainerConfig.network_mode || 'asr-network'}
                  onChange={e => setPortainerConfig({...portainerConfig, network_mode: e.target.value})}
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50"
                >
                  <option value="asr-network">asr-network (local containers)</option>
                  <option value="host">host (external ASR)</option>
                  <option value="bridge">bridge</option>
                </select>
                <div className="text-xs text-slate-500 mt-1">asr-network for mock, host for real ASR</div>
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Redis Host (for ASR)</label>
                <input
                  type="text"
                  value={portainerConfig.redis_host || 'redis'}
                  onChange={e => setPortainerConfig({...portainerConfig, redis_host: e.target.value})}
                  placeholder="redis or IP"
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50"
                />
                <div className="text-xs text-slate-500 mt-1">'redis' for asr-network, IP for host mode</div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Redis Port (for ASR)</label>
                <input
                  type="text"
                  value={portainerConfig.redis_port || '6379'}
                  onChange={e => setPortainerConfig({...portainerConfig, redis_port: e.target.value})}
                  placeholder="6379"
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50"
                />
                <div className="text-xs text-slate-500 mt-1">Default: 6379</div>
              </div>
            </div>
            
            <button
              onClick={testPortainerConnection}
              disabled={testingConnection || !portainerConfig.url || !portainerConfig.token}
              className="px-4 py-2 bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              {testingConnection ? 'Testing...' : '🔌 Test Connection'}
            </button>
            
            {/* Running containers from Portainer */}
            {portainerContainers.length > 0 && (
              <div className="mt-4">
                <div className="text-xs text-slate-400 mb-2">Running Containers:</div>
                <div className="space-y-2 max-h-40 overflow-auto">
                  {portainerContainers.filter(c => c.name.includes('asr') || c.name.includes('mock')).map(c => (
                    <div key={c.id} className="flex items-center justify-between bg-slate-800/50 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${c.state === 'running' ? 'bg-emerald-400' : 'bg-slate-500'}`} />
                        <span className="text-sm text-white">{c.name}</span>
                        <span className="text-xs text-slate-500">{c.state}</span>
                      </div>
                      {c.state === 'running' && (
                        <button
                          onClick={() => handleStop(c.name)}
                          disabled={stopping}
                          className="text-xs text-rose-400 hover:text-rose-300"
                        >
                          Stop
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      
      <div className="space-y-4">
        <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider">Basic Settings</h3>
        
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-slate-400 block mb-1">Container Name</label>
            <input
              type="text"
              value={config.name}
              onChange={e => setConfig({...config, name: e.target.value})}
              placeholder="asr-module"
              className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500/50"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Reference Voice(s) *</label>
            <input
              type="text"
              value={config.reference}
              onChange={e => setConfig({...config, reference: e.target.value})}
              placeholder="trump or trump,melania,powell"
              className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500/50"
            />
          </div>
        </div>
        
        <div>
          <label className="text-xs text-slate-400 block mb-1">Stream URL *</label>
          <input
            type="text"
            value={config.input}
            onChange={e => setConfig({...config, input: e.target.value})}
            placeholder="https://www.youtube.com/watch?v=... or Twitter Space URL"
            className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500/50"
          />
        </div>
        
        <div>
          <label className="text-xs text-slate-400 block mb-1">Words/Tokens CSV File *</label>
          <input
            type="text"
            value={config.words}
            onChange={e => setConfig({...config, words: e.target.value})}
            placeholder="tokens/trump_jan22.csv"
            className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500/50"
          />
        </div>
        
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-slate-400 block mb-1">Similarity Threshold</label>
            <input
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={config.similarity_threshold}
              onChange={e => setConfig({...config, similarity_threshold: parseFloat(e.target.value) || 0.70})}
              className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-cyan-500/50"
            />
            <div className="text-xs text-slate-500 mt-1">0.70 = default</div>
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Format (yt-dlp)</label>
            <select
              value={config.format}
              onChange={e => setConfig({...config, format: e.target.value})}
              className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500/50"
            >
              <option value="bestaudio/best[height<=360]/worst">Best Audio (default)</option>
              <option value="best">Best</option>
              <option value="worst">Worst (fastest)</option>
              <option value="bestaudio">Best Audio Only</option>
            </select>
          </div>
        </div>
        
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.print_transcript}
              onChange={e => setConfig({...config, print_transcript: e.target.checked})}
              className="w-4 h-4 rounded bg-slate-700 border-slate-600 text-cyan-500"
            />
            <span className="text-sm text-slate-300">Print Transcript</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.autostart}
              onChange={e => setConfig({...config, autostart: e.target.checked})}
              className="w-4 h-4 rounded bg-slate-700 border-slate-600 text-cyan-500"
            />
            <span className="text-sm text-slate-300">Autostart (wait for stream)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.verbose}
              onChange={e => setConfig({...config, verbose: e.target.checked})}
              className="w-4 h-4 rounded bg-slate-700 border-slate-600 text-cyan-500"
            />
            <span className="text-sm text-slate-300">Verbose</span>
          </label>
        </div>
      </div>
      
      <div>
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-sm text-slate-400 hover:text-slate-300 flex items-center gap-2"
        >
          <span>{showAdvanced ? "▼" : "▶"}</span>
          Advanced Settings
        </button>
        
        {showAdvanced && (
          <div className="mt-4 space-y-4 p-4 bg-slate-800/30 rounded-lg border border-slate-700">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Downloader</label>
                <select
                  value={config.downloader}
                  onChange={e => setConfig({...config, downloader: e.target.value})}
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                >
                  <option value="">Auto-detect</option>
                  <option value="ffmpeg">FFmpeg</option>
                  <option value="youtube">YouTube</option>
                  <option value="hls">HLS</option>
                  <option value="netflix">Netflix</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Monitor Interval (sec)</label>
                <input
                  type="number"
                  value={config.monitor_interval}
                  onChange={e => setConfig({...config, monitor_interval: parseInt(e.target.value) || 5})}
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-cyan-500/50"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">HLS Interval (sec)</label>
                <input
                  type="number"
                  step="0.1"
                  value={config.hls_interval}
                  onChange={e => setConfig({...config, hls_interval: parseFloat(e.target.value) || 0.1})}
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-cyan-500/50"
                />
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Chunk Size (ms)</label>
                <input
                  type="number"
                  value={config.chunk_size_ms}
                  onChange={e => setConfig({...config, chunk_size_ms: parseInt(e.target.value) || 5000})}
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-cyan-500/50"
                />
              </div>
            </div>
            
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.first_therm}
                  onChange={e => setConfig({...config, first_therm: e.target.checked})}
                  className="w-4 h-4 rounded bg-slate-700 border-slate-600"
                />
                <span className="text-sm text-slate-300">Exit after first word</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.no_hls_skip}
                  onChange={e => setConfig({...config, no_hls_skip: e.target.checked})}
                  className="w-4 h-4 rounded bg-slate-700 border-slate-600"
                />
                <span className="text-sm text-slate-300">No HLS Skip</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.simulate_realtime}
                  onChange={e => setConfig({...config, simulate_realtime: e.target.checked})}
                  className="w-4 h-4 rounded bg-slate-700 border-slate-600"
                />
                <span className="text-sm text-slate-300">Simulate Realtime</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.use_fc}
                  onChange={e => setConfig({...config, use_fc: e.target.checked})}
                  className="w-4 h-4 rounded bg-slate-700 border-slate-600"
                />
                <span className="text-sm text-slate-300">Use FC Channel (5.1/7.1)</span>
              </label>
            </div>
          </div>
        )}
      </div>
      
      {/* Generated Commands */}
      <div className="space-y-4">
        {/* Script Command */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-slate-400">Script Command (run_module.sh)</label>
            <button
              onClick={copyScriptCommand}
              className="text-xs text-cyan-400 hover:text-cyan-300"
            >
              {copiedScript ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="bg-slate-950 border border-slate-700 rounded-lg p-3 font-mono text-xs text-amber-400 overflow-x-auto whitespace-pre-wrap break-all">
            {scriptCommand}
          </div>
        </div>
        
        {/* Docker Command */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-slate-400">Docker Command</label>
            <button
              onClick={copyDockerCommand}
              className="text-xs text-cyan-400 hover:text-cyan-300"
            >
              {copiedDocker ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="bg-slate-950 border border-slate-700 rounded-lg p-3 font-mono text-xs text-emerald-400 overflow-x-auto whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
            {dockerCommand}
          </div>
        </div>
      </div>
      
      {/* Launch Result */}
      {launchResult && (
        <div className={`p-4 rounded-lg border ${
          launchResult.status === 'success' 
            ? 'bg-emerald-500/10 border-emerald-500/30' 
            : launchResult.status === 'error'
            ? 'bg-rose-500/10 border-rose-500/30'
            : 'bg-amber-500/10 border-amber-500/30'
        }`}>
          <div className={`text-sm font-medium ${
            launchResult.status === 'success' ? 'text-emerald-400' :
            launchResult.status === 'error' ? 'text-rose-400' : 'text-amber-400'
          }`}>
            {launchResult.status === 'success' ? '✓ ' : launchResult.status === 'error' ? '✗ ' : 'ℹ '}
            {launchResult.message}
          </div>
          {launchResult.container_id && (
            <div className="text-xs text-slate-500 mt-1">
              Container ID: {launchResult.container_id}
            </div>
          )}
          {launchResult.command && launchResult.status !== 'success' && (
            <div className="mt-2">
              <div className="text-xs text-slate-400 mb-1">Run manually:</div>
              <code className="text-xs text-slate-300 bg-slate-800 px-2 py-1 rounded block overflow-x-auto">
                {launchResult.command}
              </code>
            </div>
          )}
        </div>
      )}
      
      {/* Launch Button */}
      <button 
        onClick={handleLaunch}
        disabled={launching || !portainerConfig.token}
        className="w-full py-4 bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 disabled:from-slate-600 disabled:to-slate-600 disabled:cursor-not-allowed text-white font-bold rounded-xl transition-all transform hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-emerald-500/25 text-lg"
      >
        {launching ? "Launching..." : "🚀 Launch Container"}
      </button>
      
      {!portainerConfig.token && (
        <div className="text-xs text-amber-400 text-center">
          ⚠️ Configure Portainer settings above to enable launch
        </div>
      )}
    </div>
  );
}

// Exchange Orderbook viewer - loads from Kalshi/Polymarket API
function ExchangeOrderbookView({ tokenId, tokenInfo, investAmount, setInvestAmount }) {
  const [orderbook, setOrderbook] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!tokenId) return;
    
    setLoading(true);
    setError(null);
    
    // Fetch from Redis orderbook (not exchange API)
    fetch(`${API_URL}/api/orderbook/${encodeURIComponent(tokenId)}?history=1`)
      .then(r => {
        if (r.status === 404) {
          return { snapshots: [], notFound: true };
        }
        return r.json();
      })
      .then(data => {
        if (data.notFound || !data.snapshots || data.snapshots.length === 0) {
          setOrderbook(null);
          setError("No orderbook data in Redis. Token may not be tracked yet.");
        } else {
          // Get latest snapshot and convert format
          const latest = data.snapshots[0];
          const asks = (latest.asks || []).map(([price, qty]) => ({ 
            price: parseFloat(price), 
            size: parseFloat(qty) 
          }));
          const bids = (latest.bids || []).map(([price, qty]) => ({ 
            price: parseFloat(price), 
            size: parseFloat(qty) 
          }));
          
          // Sort: asks ascending, bids descending
          asks.sort((a, b) => a.price - b.price);
          bids.sort((a, b) => b.price - a.price);
          
          setOrderbook({
            asks,
            bids,
            best_ask: asks.length > 0 ? asks[0].price : 100,
            best_bid: bids.length > 0 ? bids[0].price : 0,
            timestamp: latest._timestamp
          });
        }
      })
      .catch(err => {
        setError(err.message);
        setOrderbook(null);
      })
      .finally(() => setLoading(false));
  }, [tokenId]);

  if (!tokenId) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500">
        ← Select a token to view orderbook
      </div>
    );
  }

  if (loading) {
    return <div className="animate-pulse bg-slate-800/30 h-full rounded" />;
  }

  const bids = orderbook?.bids || [];
  const asks = orderbook?.asks || [];
  const bestBid = orderbook?.best_bid || 0;
  const bestAsk = orderbook?.best_ask || 100;
  
  // Helper to format price (handles both cents and dollars format)
  const formatPrice = (price) => {
    const p = parseFloat(price);
    // If price > 1, assume cents, convert to dollars
    const dollars = p > 1 ? p / 100 : p;
    return `$${dollars.toFixed(2)}`;
  };
  
  // Get price in dollars for calculations
  const toDollars = (price) => {
    const p = parseFloat(price);
    return p > 1 ? p / 100 : p;
  };
  
  // Calculate profit based on actual liquidity in the orderbook
  const calculateProfit = () => {
    if (!asks.length || !investAmount) return null;
    
    let remaining = investAmount;
    let totalShares = 0;
    
    // Walk through asks to see how many shares we can actually buy
    for (const ask of asks) {
      // Price might be in cents (1-100) or dollars (0.01-1.00)
      // If price > 1, assume cents and convert to dollars
      const rawPrice = parseFloat(ask.price);
      const price = rawPrice > 1 ? rawPrice / 100 : rawPrice;
      const size = parseFloat(ask.size);
      const cost = price * size;
      
      if (remaining >= cost) {
        totalShares += size;
        remaining -= cost;
      } else {
        totalShares += remaining / price;
        remaining = 0;
        break;
      }
    }
    
    const actualInvested = investAmount - remaining;
    const ifWins = totalShares * 1;
    const profit = ifWins - actualInvested;
    const roi = actualInvested > 0 ? (profit / actualInvested) * 100 : 0;
    
    return { 
      shares: Math.floor(totalShares), 
      cost: actualInvested, 
      ifWins, 
      profit, 
      roi,
      notEnoughLiquidity: remaining > 0,
      actualInvested
    };
  };
  
  const profit = calculateProfit();

  return (
    <div className="space-y-4">
      {/* Token Header */}
      <div>
        <h3 className="text-sm font-bold text-cyan-400 break-all">{tokenId}</h3>
        {tokenInfo?.word && (
          <p className="text-xs text-slate-400 mt-1">Word: <span className="text-white">{tokenInfo.word}</span></p>
        )}
        {tokenInfo?.source && (
          <p className="text-xs text-slate-400">Source: {tokenInfo.source}</p>
        )}
      </div>
      
      {/* Price Summary */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
        <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Current Price</div>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-2xl font-bold text-white">{formatPrice(bestAsk)}</span>
            <span className="text-xs text-slate-500 ml-2">ask</span>
          </div>
          <div className="text-right">
            <span className="text-lg text-emerald-400">{formatPrice(bestBid)}</span>
            <span className="text-xs text-slate-500 ml-2">bid</span>
          </div>
        </div>
        <div className="text-xs text-slate-500 mt-2">
          Spread: ${(toDollars(bestAsk) - toDollars(bestBid)).toFixed(2)} ({((toDollars(bestAsk) - toDollars(bestBid)) / toDollars(bestAsk) * 100).toFixed(1)}%)
        </div>
      </div>
      
      {/* Profit Calculator */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
        <div className="text-xs uppercase tracking-wider text-slate-400 mb-3">Profit Calculator</div>
        
        <div className="flex items-center gap-2 mb-3">
          <span className="text-slate-400 text-sm">Invest $</span>
          <input
            type="number"
            value={investAmount}
            onChange={e => setInvestAmount(parseFloat(e.target.value) || 0)}
            className="w-24 px-2 py-1 bg-slate-700 border border-slate-600 rounded text-white text-sm"
          />
        </div>
        
        {profit && (
          <>
            {profit.notEnoughLiquidity && (
              <div className="mb-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
                ⚠️ Only ${profit.actualInvested.toFixed(2)} liquidity available
              </div>
            )}
            <div className="grid grid-cols-4 gap-2 text-center">
              <div>
                <div className="text-xs text-slate-500">Shares</div>
                <div className="text-sm font-bold text-white">{profit.shares}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">If Wins</div>
                <div className="text-sm font-bold text-white">${profit.ifWins.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Profit</div>
                <div className={`text-sm font-bold ${profit.profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {profit.profit >= 0 ? '+' : ''}${profit.profit.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">ROI</div>
                <div className={`text-sm font-bold ${profit.roi >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {profit.roi >= 0 ? '+' : ''}{profit.roi.toFixed(0)}%
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      
      {/* Orderbook */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
        <div className="text-xs uppercase tracking-wider text-slate-400 mb-3">Orderbook</div>
        
        {error ? (
          <div className="text-sm text-rose-400">{error}</div>
        ) : !bids.length && !asks.length ? (
          <div className="text-sm text-slate-500">No orderbook data available</div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {/* Asks (Sell) - reversed so lowest price at bottom */}
            <div>
              <div className="text-xs font-bold text-rose-400 mb-2">ASKS (SELL)</div>
              <div className="space-y-1 flex flex-col-reverse">
                {asks.slice(0, 8).map((ask, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span className="text-rose-400 font-mono">{formatPrice(ask.price)}</span>
                    <span className="text-slate-400">{ask.size}</span>
                  </div>
                ))}
                {asks.length === 0 && <div className="text-xs text-slate-500">No asks</div>}
              </div>
            </div>
            
            {/* Bids (Buy) */}
            <div>
              <div className="text-xs font-bold text-emerald-400 mb-2">BIDS (BUY)</div>
              <div className="space-y-1">
                {bids.slice(0, 8).map((bid, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span className="text-emerald-400 font-mono">{formatPrice(bid.price)}</span>
                    <span className="text-slate-400">{bid.size}</span>
                  </div>
                ))}
                {bids.length === 0 && <div className="text-xs text-slate-500">No bids</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Tokens Manager - Kalshi/Polymarket events
function TokensManager() {
  const [source, setSource] = useState("both");
  const [filter, setFilter] = useState("");
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [savedTokens, setSavedTokens] = useState([]);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [selectedSavedToken, setSelectedSavedToken] = useState(null);
  const [investAmount, setInvestAmount] = useState(100);

  // Search tokens directly
  const loadEvents = async () => {
    if (!filter || filter.trim().length < 2) {
      setResult({ status: "error", message: "Enter at least 2 characters to search" });
      return;
    }
    
    setLoading(true);
    setResult(null);
    try {
      const params = new URLSearchParams({ source, q: filter });
      
      const res = await fetch(`${API_URL}/api/search-tokens?${params}`);
      const data = await res.json();
      setEvents(data.tokens || []);
      setSelected(new Set());
    } catch (err) {
      setResult({ status: "error", message: err.message });
    } finally {
      setLoading(false);
    }
  };

  // Load saved tokens
  const loadSavedTokens = async () => {
    setLoadingSaved(true);
    try {
      const res = await fetch(`${API_URL}/api/market-events/saved`);
      const data = await res.json();
      setSavedTokens(data.tokens || []);
    } catch (err) {
      console.error("Failed to load saved tokens:", err);
    } finally {
      setLoadingSaved(false);
    }
  };

  // Save selected tokens to Redis
  const saveToRedis = async () => {
    if (selected.size === 0) return;
    
    setSaving(true);
    setResult(null);
    try {
      const selectedTokens = events.filter((_, i) => selected.has(i));
      
      // Save tokens directly (including event for grouping)
      const res = await fetch(`${API_URL}/api/market-events/save-tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokens: selectedTokens.map(t => ({
            token_id: t.token_id,
            word: t.title,
            source: t.source,
            event: t.event  // Include event name for grouping
          }))
        })
      });
      const data = await res.json();
      
      if (data.status === "success") {
        setResult({ status: "success", message: `Saved ${data.saved} tokens to Redis` });
        loadSavedTokens();
      } else {
        setResult({ status: "error", message: data.message || "Failed to save" });
      }
    } catch (err) {
      setResult({ status: "error", message: err.message });
    } finally {
      setSaving(false);
    }
  };

  // Clear tokens
  const clearTokens = async () => {
    if (!confirm("Clear all tokens from Redis?")) return;
    
    try {
      await fetch(`${API_URL}/api/market-events/clear`, { method: "DELETE" });
      setSavedTokens([]);
      setResult({ status: "success", message: "Tokens cleared" });
    } catch (err) {
      setResult({ status: "error", message: err.message });
    }
  };

  // Delete single token
  const deleteToken = async (tokenId, e) => {
    e.stopPropagation(); // Don't trigger row click
    
    try {
      await fetch(`${API_URL}/api/market-events/token/${encodeURIComponent(tokenId)}`, { method: "DELETE" });
      setSavedTokens(savedTokens.filter(t => t.token_id !== tokenId));
      if (selectedSavedToken?.token_id === tokenId) {
        setSelectedSavedToken(null);
      }
    } catch (err) {
      console.error("Delete error:", err);
    }
  };

  // Toggle selection
  const toggleSelect = (index) => {
    const newSelected = new Set(selected);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelected(newSelected);
  };

  // Select all
  const selectAll = () => {
    if (selected.size === events.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(events.map((_, i) => i)));
    }
  };

  // Load saved on mount
  useEffect(() => {
    loadSavedTokens();
  }, []);

  // Resizable panel - начальная ширина как на скрине (~420px)
  const [leftPanelWidth, setLeftPanelWidth] = useState(420);
  const isResizingRef = useRef(false);
  const panelRef = useRef(null);
  
  // Editing state
  const [editingToken, setEditingToken] = useState(null);
  const [editValue, setEditValue] = useState("");

  // Resize handlers
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizingRef.current || !panelRef.current) return;
      
      const panelRect = panelRef.current.getBoundingClientRect();
      const newWidth = e.clientX - panelRect.left;
      
      // Ограничения: min 200px, max 50% экрана
      const clampedWidth = Math.max(200, Math.min(window.innerWidth * 0.5, newWidth));
      setLeftPanelWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const startResize = (e) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Update token word in Redis
  const updateTokenWord = async (tokenId, newWord) => {
    try {
      const res = await fetch(`${API_URL}/api/tokens/${encodeURIComponent(tokenId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: newWord })
      });
      const data = await res.json();
      if (data.status === "success") {
        // Update local state
        setSavedTokens(prev => prev.map(t => 
          t.token_id === tokenId ? { ...t, word: newWord } : t
        ));
      }
    } catch (err) {
      console.error("Failed to update token:", err);
    }
    setEditingToken(null);
  };

  // Start editing
  const startEditing = (token, e) => {
    e.stopPropagation();
    setEditingToken(token.token_id);
    setEditValue(token.word || "");
  };

  // Handle edit keydown
  const handleEditKeyDown = (e, tokenId) => {
    if (e.key === "Enter") {
      updateTokenWord(tokenId, editValue);
    } else if (e.key === "Escape") {
      setEditingToken(null);
    }
  };

  return (
    <div className="flex h-[calc(100vh-140px)] gap-2">
      {/* Left: Saved Tokens - Resizable */}
      <div 
        ref={panelRef}
        className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 flex-shrink-0"
        style={{ width: leftPanelWidth }}
      >
        <div className="flex justify-between items-center mb-3">
          <div>
            <h2 className="text-base font-bold text-white">SAVED TOKENS</h2>
            <p className="text-xs text-slate-500">{savedTokens.length} tokens</p>
          </div>
          <div className="flex gap-1">
            <button
              onClick={loadSavedTokens}
              disabled={loadingSaved}
              className="p-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded text-xs"
              title="Refresh"
            >
              ↻
            </button>
            <button
              onClick={clearTokens}
              className="p-1.5 bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 rounded text-xs"
              title="Clear All"
            >
              ✕
            </button>
          </div>
        </div>
        
        <div className="border border-slate-700 rounded-lg overflow-hidden">
          <div className="max-h-[calc(100vh-280px)] overflow-y-auto">
            {savedTokens.length === 0 ? (
              <div className="p-4 text-center text-slate-500 text-sm">
                No tokens saved yet.<br/>
                <span className="text-xs">Add from panel on right →</span>
              </div>
            ) : (
              (() => {
                // Group ALL tokens by event
                const kalshiEvents = {};
                const polymarketEvents = {};
                
                savedTokens.forEach(token => {
                  const isKalshi = token.token_id?.startsWith('KX');
                  
                  if (isKalshi) {
                    // Kalshi: group by event prefix (KXTRUMPSAYMONTH-26FEB01)
                    const parts = token.token_id?.split('-') || [];
                    const eventKey = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'Other';
                    if (!kalshiEvents[eventKey]) kalshiEvents[eventKey] = [];
                    kalshiEvents[eventKey].push(token);
                  } else {
                    // Polymarket: group by event field
                    const eventKey = token.event || 'Other';
                    if (!polymarketEvents[eventKey]) polymarketEvents[eventKey] = [];
                    polymarketEvents[eventKey].push(token);
                  }
                });
                
                return (
                  <>
                    {/* Kalshi events */}
                    {Object.entries(kalshiEvents).map(([eventKey, tokens]) => (
                      <div key={`k-${eventKey}`}>
                        {/* Event header */}
                        <div className="bg-emerald-500/10 px-2 py-1.5 border-b border-slate-700 flex items-center gap-2">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 flex-shrink-0">K</span>
                          <span className="text-xs text-emerald-400 font-medium flex-1">{eventKey}</span>
                          <span className="text-xs text-slate-500 flex-shrink-0">({tokens.length})</span>
                        </div>
                        {/* Tokens in event */}
                        {tokens.map((token, i) => (
                          <div
                            key={token.token_id || i}
                            onClick={() => setSelectedSavedToken(selectedSavedToken?.token_id === token.token_id ? null : token)}
                            className={`pl-4 pr-2 py-1.5 border-b border-slate-700/30 cursor-pointer transition-colors group ${
                              selectedSavedToken?.token_id === token.token_id 
                                ? 'bg-cyan-500/10 border-l-2 border-l-cyan-500' 
                                : 'hover:bg-slate-800/30'
                            }`}
                          >
                            <div className="flex justify-between items-center gap-2">
                              <div className="flex-1 min-w-0">
                                {editingToken === token.token_id ? (
                                  <input
                                    type="text"
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onKeyDown={(e) => handleEditKeyDown(e, token.token_id)}
                                    onBlur={() => updateTokenWord(token.token_id, editValue)}
                                    autoFocus
                                    className="w-full bg-slate-800 border border-cyan-500 rounded px-1 py-0.5 text-sm text-cyan-400 outline-none"
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                ) : (
                                  <div 
                                    className="cursor-text"
                                    onDoubleClick={(e) => startEditing(token, e)}
                                    title="Double-click to edit"
                                  >
                                    <div className="text-cyan-400 text-sm font-medium">
                                      {token.word || token.token_id?.split('-').pop() || '(no word)'}
                                    </div>
                                    <div className="text-xs text-slate-600 font-mono break-all">
                                      {token.token_id}
                                    </div>
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <button
                                  onClick={(e) => startEditing(token, e)}
                                  className="opacity-0 group-hover:opacity-100 w-7 h-7 flex items-center justify-center rounded border border-slate-600 hover:border-cyan-500 text-slate-400 hover:text-cyan-400 hover:bg-cyan-500/10 transition-all text-sm"
                                  title="Edit word"
                                >
                                  ✎
                                </button>
                                <button
                                  onClick={(e) => deleteToken(token.token_id, e)}
                                  className="opacity-0 group-hover:opacity-100 w-7 h-7 flex items-center justify-center rounded border border-slate-600 hover:border-rose-500 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-all text-sm"
                                  title="Delete token"
                                >
                                  ×
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                    
                    {/* Polymarket events */}
                    {Object.entries(polymarketEvents).map(([eventKey, tokens]) => (
                      <div key={`p-${eventKey}`}>
                        {/* Event header */}
                        <div className="bg-blue-500/10 px-2 py-1.5 border-b border-slate-700 flex items-center gap-2">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 flex-shrink-0">P</span>
                          <span className="text-xs text-blue-400 font-medium flex-1" title={eventKey}>
                            {eventKey}
                          </span>
                          <span className="text-xs text-slate-500 flex-shrink-0">({tokens.length})</span>
                        </div>
                        {/* Tokens in event */}
                        {tokens.map((token, i) => (
                          <div
                            key={token.token_id || i}
                            onClick={() => setSelectedSavedToken(selectedSavedToken?.token_id === token.token_id ? null : token)}
                            className={`pl-4 pr-2 py-1.5 border-b border-slate-700/30 cursor-pointer transition-colors group ${
                              selectedSavedToken?.token_id === token.token_id 
                                ? 'bg-cyan-500/10 border-l-2 border-l-cyan-500' 
                                : 'hover:bg-slate-800/30'
                            }`}
                          >
                            <div className="flex justify-between items-center gap-2">
                              <div className="flex-1 min-w-0">
                                {editingToken === token.token_id ? (
                                  <input
                                    type="text"
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onKeyDown={(e) => handleEditKeyDown(e, token.token_id)}
                                    onBlur={() => updateTokenWord(token.token_id, editValue)}
                                    autoFocus
                                    className="w-full bg-slate-800 border border-cyan-500 rounded px-1 py-0.5 text-sm text-cyan-400 outline-none"
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                ) : (
                                  <div 
                                    className="cursor-text"
                                    onDoubleClick={(e) => startEditing(token, e)}
                                    title="Double-click to edit"
                                  >
                                    <div className="text-cyan-400 text-sm font-medium">
                                      {token.word || '(no word)'}
                                    </div>
                                    <div className="text-xs text-slate-600 font-mono break-all">
                                      {token.token_id}
                                    </div>
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <button
                                  onClick={(e) => startEditing(token, e)}
                                  className="opacity-0 group-hover:opacity-100 w-7 h-7 flex items-center justify-center rounded border border-slate-600 hover:border-cyan-500 text-slate-400 hover:text-cyan-400 hover:bg-cyan-500/10 transition-all text-sm"
                                  title="Edit word"
                                >
                                  ✎
                                </button>
                                <button
                                  onClick={(e) => deleteToken(token.token_id, e)}
                                  className="opacity-0 group-hover:opacity-100 w-7 h-7 flex items-center justify-center rounded border border-slate-600 hover:border-rose-500 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-all text-sm"
                                  title="Delete token"
                                >
                                  ×
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </>
                );
              })()
            )}
          </div>
        </div>
      </div>
      
      {/* Resize handle - между панелями */}
      <div
        className="w-1 hover:w-2 bg-slate-700 hover:bg-cyan-500/50 cursor-col-resize transition-all flex-shrink-0 rounded-full my-4"
        onMouseDown={startResize}
      />
      
      {/* Center: Orderbook */}
      <div className="flex-1 bg-slate-900/50 border border-slate-800 rounded-xl p-4 min-w-[300px] ml-1">
        <h2 className="text-xs uppercase tracking-wider text-slate-400 mb-3">ORDERBOOK</h2>
        <ExchangeOrderbookView 
          tokenId={selectedSavedToken?.token_id} 
          tokenInfo={selectedSavedToken}
          investAmount={investAmount}
          setInvestAmount={setInvestAmount}
        />
      </div>
      
      {/* Right: Load Events */}
      <div className="w-[350px] flex-shrink-0 bg-slate-900/50 border border-slate-800 rounded-xl p-4 ml-2">
        <h2 className="text-base font-bold text-white mb-1">ADD TOKENS</h2>
        <p className="text-xs text-slate-500 mb-3">Search all markets on Kalshi/Polymarket</p>
        
        {/* Controls */}
        <div className="flex gap-2 mb-2">
          <select
            value={source}
            onChange={e => setSource(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-white"
          >
            <option value="both">Both</option>
            <option value="kalshi">Kalshi</option>
            <option value="polymarket">Polymarket</option>
          </select>
          
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Search (e.g. trump)"
            className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-white min-w-0"
            onKeyDown={e => e.key === "Enter" && loadEvents()}
          />
          
          <button
            onClick={loadEvents}
            disabled={loading}
            className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:bg-slate-600 text-white rounded text-xs font-medium"
          >
            {loading ? "..." : "Search"}
          </button>
        </div>
        
        {/* Events list */}
        <div className="border border-slate-700 rounded-lg overflow-hidden mb-3">
          <div className="bg-slate-800/50 px-2 py-1.5 flex justify-between items-center border-b border-slate-700">
            <span className="text-xs text-slate-400">
              {events.length} found, {selected.size} selected
            </span>
            <button
              onClick={selectAll}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              {selected.size === events.length ? "None" : "All"}
            </button>
          </div>
          
          <div className="max-h-[350px] overflow-y-auto">
            {events.length === 0 ? (
              <div className="p-3 text-center text-slate-500 text-xs">
                {loading ? "Loading..." : "Enter search query and click Search"}
              </div>
            ) : (
              (() => {
                // Group tokens by event
                const grouped = {};
                events.forEach((token, i) => {
                  const eventKey = token.event || token.title;
                  if (!grouped[eventKey]) {
                    grouped[eventKey] = {
                      event: eventKey,
                      source: token.source,
                      tokens: []
                    };
                  }
                  grouped[eventKey].tokens.push({ ...token, originalIndex: i });
                });
                
                // Sort groups - mention events first
                const mentionKeywords = ['say', 'mention', 'word', 'nickname', 'state of the union'];
                const sortedGroups = Object.values(grouped).sort((a, b) => {
                  const aIsMention = mentionKeywords.some(kw => a.event.toLowerCase().includes(kw));
                  const bIsMention = mentionKeywords.some(kw => b.event.toLowerCase().includes(kw));
                  if (aIsMention && !bIsMention) return -1;
                  if (!aIsMention && bIsMention) return 1;
                  return a.event.localeCompare(b.event);
                });
                
                // Helper to select all tokens in a group
                const toggleGroupSelect = (group) => {
                  const indices = group.tokens.map(t => t.originalIndex);
                  const allSelected = indices.every(i => selected.has(i));
                  const newSelected = new Set(selected);
                  if (allSelected) {
                    indices.forEach(i => newSelected.delete(i));
                  } else {
                    indices.forEach(i => newSelected.add(i));
                  }
                  setSelected(newSelected);
                };
                
                return sortedGroups.map((group, gi) => {
                  const groupIndices = group.tokens.map(t => t.originalIndex);
                  const selectedInGroup = groupIndices.filter(i => selected.has(i)).length;
                  const isMention = mentionKeywords.some(kw => group.event.toLowerCase().includes(kw));
                  
                  return (
                    <div key={gi} className="border-b border-slate-700">
                      {/* Event Header */}
                      <div 
                        className={`px-2 py-2 flex items-center gap-2 cursor-pointer hover:bg-slate-800/30 ${
                          isMention ? 'bg-amber-500/5' : 'bg-slate-800/20'
                        }`}
                        onClick={() => toggleGroupSelect(group)}
                      >
                        <input
                          type="checkbox"
                          checked={selectedInGroup === group.tokens.length}
                          onChange={() => {}}
                          className="rounded bg-slate-700 border-slate-600 w-3.5 h-3.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className={`text-xs font-medium truncate ${isMention ? 'text-amber-400' : 'text-slate-300'}`}>
                            {group.event}
                          </div>
                          <div className="text-xs text-slate-500">
                            {group.tokens.length} token{group.tokens.length > 1 ? 's' : ''} 
                            {selectedInGroup > 0 && ` • ${selectedInGroup} selected`}
                          </div>
                        </div>
                        <span className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${
                          group.source === "kalshi" 
                            ? "bg-emerald-500/20 text-emerald-400" 
                            : "bg-blue-500/20 text-blue-400"
                        }`}>
                          {group.source === "kalshi" ? "K" : "P"}
                        </span>
                      </div>
                      
                      {/* Tokens in group */}
                      <div className="bg-slate-900/30">
                        {group.tokens.map((token) => (
                          <div
                            key={token.token_id}
                            onClick={(e) => { e.stopPropagation(); toggleSelect(token.originalIndex); }}
                            className={`pl-6 pr-2 py-1 flex items-center gap-2 cursor-pointer hover:bg-slate-800/50 border-t border-slate-700/30 ${
                              selected.has(token.originalIndex) ? "bg-blue-500/10" : ""
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={selected.has(token.originalIndex)}
                              onChange={() => {}}
                              className="rounded bg-slate-700 border-slate-600 w-3 h-3"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="text-xs text-white truncate" title={token.title}>{token.title}</div>
                              <div className="text-xs text-slate-600 truncate font-mono" title={token.token_id}>
                                {token.token_id.length > 30 ? token.token_id.slice(0, 30) + '...' : token.token_id}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                });
              })()
            )}
          </div>
        </div>
        
        {/* Save button */}
        <button
          onClick={saveToRedis}
          disabled={saving || selected.size === 0}
          className="w-full py-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-bold rounded text-sm"
        >
          {saving ? "Saving..." : `Save ${selected.size} to Redis`}
        </button>
        
        {/* Result */}
        {result && (
          <div className={`mt-2 p-2 rounded text-xs ${
            result.status === "success" 
              ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
              : "bg-rose-500/10 border border-rose-500/20 text-rose-400"
          }`}>
            {result.message}
          </div>
        )}
      </div>
    </div>
  );
}

// Main App
export default function App() {
  const [activeTab, setActiveTab] = useState("monitor");
  const [selectedToken, setSelectedToken] = useState(null);
  const [investAmount, setInvestAmount] = useState(100);
  const [hideUnknown, setHideUnknown] = useState(true);
  const [connected, setConnected] = useState(false);
  
  // Auto-refresh stats every 3 seconds
  const { data: stats, loading: statsLoading } = useApiPolling('/api/stats', 3000);
  
  useEffect(() => {
    fetch(`${API_URL}/`)
      .then(r => r.ok && setConnected(true))
      .catch(() => setConnected(false));
  }, []);
  
  return (
    <div className="min-h-screen bg-slate-950 text-white" style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center text-xl">
              📡
            </div>
            <div>
              <h1 className="text-lg font-bold bg-gradient-to-r from-cyan-400 to-emerald-400 bg-clip-text text-transparent">
                ASR Monitor
              </h1>
              <div className="text-xs text-slate-500">Polymarket Sniper Dashboard</div>
            </div>
          </div>
          
          <div className={`flex items-center gap-1 px-3 py-1 border rounded-full ${
            connected 
              ? "bg-emerald-500/20 border-emerald-500/30" 
              : "bg-rose-500/20 border-rose-500/30"
          }`}>
            <div className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-400 animate-pulse" : "bg-rose-400"}`} />
            <span className={`text-xs ${connected ? "text-emerald-400" : "text-rose-400"}`}>
              {connected ? "Connected" : "Disconnected"}
            </span>
          </div>
        </div>
        
        <div className="max-w-[1600px] mx-auto px-4 flex gap-1">
          {[
            { id: "monitor", label: "Monitor" },
            { id: "streams", label: "Streams" },
            { id: "launch", label: "Launch" },
            { id: "tokens", label: "Tokens" },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${
                activeTab === tab.id
                  ? "bg-slate-800 text-white"
                  : "text-slate-500 hover:text-slate-300 hover:bg-slate-800/50"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>
      
      <main className="max-w-[1600px] mx-auto p-4">
        {activeTab === "monitor" && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <StatCard label="Total Detections" value={stats?.total_detections} loading={statsLoading} color="emerald" />
              <StatCard label="Unique Tokens" value={stats?.unique_tokens} loading={statsLoading} color="cyan" />
              <StatCard label="Orderbooks" value={stats?.orderbooks_count} loading={statsLoading} color="rose" />
            </div>
            
            <div className="grid grid-cols-12 gap-4" style={{ height: "calc(100vh - 260px)" }}>
              <div className="col-span-5 bg-slate-900/50 border border-slate-800 rounded-xl p-4 overflow-hidden flex flex-col">
                <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-3">
                  Token Counts
                </h2>
                <TokensTable 
                  onSelect={setSelectedToken}
                  selectedToken={selectedToken}
                  hideUnknown={hideUnknown}
                  setHideUnknown={setHideUnknown}
                />
              </div>
              
              <div className="col-span-4 bg-slate-900/50 border border-slate-800 rounded-xl p-4 overflow-auto">
                <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-3">
                  Orderbook
                </h2>
                <OrderbookView 
                  tokenId={selectedToken}
                  investAmount={investAmount}
                  setInvestAmount={setInvestAmount}
                />
              </div>
              
              <div className="col-span-3 bg-slate-900/50 border border-slate-800 rounded-xl p-4 overflow-hidden flex flex-col">
                <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-3">
                  Live Feed
                </h2>
                <div className="flex-1 overflow-auto">
                  <LiveFeed />
                </div>
              </div>
            </div>
          </div>
        )}
        
        {activeTab === "streams" && (
          <StreamRaces />
        )}
        
        {activeTab === "launch" && (
          <div className="max-w-3xl mx-auto">
            <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-6">
              <h2 className="text-xl font-bold text-white mb-1">Launch ASR Module</h2>
              <p className="text-sm text-slate-500 mb-6">Configure and start a new speech recognition module</p>
              <ModuleLauncher />
            </div>
          </div>
        )}
        
        {activeTab === "tokens" && (
          <TokensManager />
        )}
      </main>
      
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #475569; }
      `}</style>
    </div>
  );
}
