"use client";

import React, { useEffect, useState, useRef } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  CandlestickSeries,
  Time,
  MouseEventParams
} from "lightweight-charts";
import { Play, Pause, RotateCcw, FastForward, Target, ShieldAlert, Ban, Activity } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// --- Utility ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Constants ---
const MARKET_OPEN_MIN = 570; // 09:30
const MARKET_CLOSE_MIN = 970; // 16:10

// --- Types ---
type Tick = { ts: string; price: number; volume: number; m: number };
type WeekData = { weekStart: string; days: string[] };

type Position = {
  symbol: string;
  side: "LONG" | "SHORT";
  avgPrice: number;
  size: number;
  sl?: number;
  tp?: number;
  pnl: number;
};

type InstrumentConfig = {
  symbol: string;
  name: string;
  tickSize: number;
  multiplierMini: number;
  multiplierMicro: number;
};

const INSTRUMENTS: Record<string, InstrumentConfig> = {
  es: { symbol: "ES", name: "E-Mini S&P 500", tickSize: 0.25, multiplierMini: 50, multiplierMicro: 5 },
  nq: { symbol: "NQ", name: "E-Mini Nasdaq", tickSize: 0.25, multiplierMini: 20, multiplierMicro: 2 },
};

// --- API Helpers ---
async function fetchWeeks(): Promise<WeekData[]> {
  try {
    const res = await fetch("/api/availability/weeks");
    return (await res.json()).weeks || [];
  } catch (e) {
    console.error("Failed to fetch weeks", e);
    return [];
  }
}

async function fetchTicks(
  instrument: string,
  day: string,
  cursor: string = "0",
  startMin: number = MARKET_OPEN_MIN
): Promise<{ ticks: Tick[]; nextCursor: string; done: boolean; symbol: string | null }> {
  const params = new URLSearchParams({
    instrument,
    day,
    cursor,
    startMinute: startMin.toString(),
    endMinute: MARKET_CLOSE_MIN.toString(),
    limit: "50000",
  });

  const res = await fetch(`/api/ticks?${params.toString()}`);
  if (!res.ok) throw new Error("API Error");
  return res.json();
}

const formatTimeNy = (time: number) => {
  const date = new Date(time * 1000);
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/New_York",
  }).format(date);
};

// --- Main Component ---
export default function TradingReplayPage() {
  // Global State
  const [layout, setLayout] = useState<"SPLIT" | "ES" | "NQ">("NQ");
  const [weeks, setWeeks] = useState<WeekData[]>([]);
  const [selectedWeek, setSelectedWeek] = useState<string>("");
  const [selectedDay, setSelectedDay] = useState<string>("");

  // Controls
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [jumpHour, setJumpHour] = useState(9);
  const [jumpMin, setJumpMin] = useState(30);
  const [orderSize, setOrderSize] = useState(1);

  // Interaction State
  const [editMode, setEditMode] = useState<{ symbol: string, type: "SL" | "TP" } | null>(null);

  // Status
  const [currentTimeDisplay, setCurrentTimeDisplay] = useState("09:30:00");
  const [currentMinute, setCurrentMinute] = useState(MARKET_OPEN_MIN);
  const [isLoading, setIsLoading] = useState(false);

  // Trading
  const [accountBalance, setAccountBalance] = useState(100000);
  const [contractType, setContractType] = useState<"MINI" | "MICRO">("MINI");
  const [positions, setPositions] = useState<Record<string, Position>>({});

  // Refs
  const engineRef = useRef({
    es: { buffer: [] as Tick[], cursor: "0", done: false, lastLoadedIndex: -1, currentPrice: 0, candle: null as any },
    nq: { buffer: [] as Tick[], cursor: "0", done: false, lastLoadedIndex: -1, currentPrice: 0, candle: null as any },
    globalTimeBig: 0n,
    lastFrameTime: 0,
    animationFrameId: 0,
    loadingMore: false,
    startMinute: MARKET_OPEN_MIN
  });

  const chartContainerRefs = { es: useRef<HTMLDivElement>(null), nq: useRef<HTMLDivElement>(null) };
  const chartsRef = useRef<{ [key: string]: { chart: any; series: any; lines: any[] } | null }>({ es: null, nq: null });

  // --- Init ---
  useEffect(() => {
    fetchWeeks().then((data) => {
      setWeeks(data);
      if (data.length > 0) {
        setSelectedWeek(data[0].weekStart);
        if (data[0].days.length > 0) {
          const firstDay = data[0].days[0];
          setSelectedDay(firstDay);
          loadData(firstDay, MARKET_OPEN_MIN);
        }
      }
    });
  }, []);

  // --- Keyboard Shortcuts ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          setIsPlaying(p => !p);
          break;
        case "ArrowUp":
          e.preventDefault();
          setPlaybackSpeed(s => Math.min(s + 5, 500));
          break;
        case "ArrowDown":
          e.preventDefault();
          setPlaybackSpeed(s => Math.max(s - 5, 1));
          break;
        case "ArrowRight":
          if (selectedDay) {
            const nextMin = Math.min(MARKET_CLOSE_MIN, currentMinute + 10);
            loadData(selectedDay, nextMin);
          }
          break;
        case "ArrowLeft":
          if (selectedDay) {
            const prevMin = Math.max(MARKET_OPEN_MIN, currentMinute - 10);
            loadData(selectedDay, prevMin);
          }
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedDay, currentMinute]);

  // --- Chart Setup & Interaction ---
  const initChart = (instrument: "es" | "nq", container: HTMLElement) => {
    if (chartsRef.current[instrument]) return;

    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: "#0f172a" }, textColor: "#94a3b8" },
      grid: { vertLines: { color: "#1e293b" }, horzLines: { color: "#1e293b" } },
      width: container.clientWidth,
      height: container.clientHeight,
      timeScale: {
        timeVisible: true, secondsVisible: false, borderColor: "#334155",
        tickMarkFormatter: (time: number) => formatTimeNy(time),
      },
      rightPriceScale: { borderColor: "#334155" },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: (time: number) => formatTimeNy(time) }
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981", downColor: "#ef4444", borderVisible: false, wickUpColor: "#10b981", wickDownColor: "#ef4444",
    });

    chartsRef.current[instrument] = { chart, series, lines: [] };

    // Resize Observer
    const resizeObserver = new ResizeObserver((entries) => {
      if (entries[0]?.contentRect) chart.applyOptions({ width: entries[0].contentRect.width, height: entries[0].contentRect.height });
    });
    resizeObserver.observe(container);
  };

  // Attach Click Listener
  useEffect(() => {
    const handleChartClick = (param: MouseEventParams, instrument: string) => {
      if (!editMode || editMode.symbol !== instrument.toUpperCase() || !param.point) return;

      const chartObj = chartsRef.current[instrument];
      if (!chartObj) return;

      const price = chartObj.series.coordinateToPrice(param.point.y);
      if (!price) return;

      const currentPrice = engineRef.current[instrument as "es" | "nq"].currentPrice;

      // --- STRICT VALIDATION TO PREVENT INSTANT CLOSE ---
      setPositions(prev => {
        const pos = prev[editMode.symbol];
        if (!pos) return prev;

        let isValid = true;
        let errorMsg = "";

        if (pos.side === "LONG") {
          if (editMode.type === "SL" && price >= currentPrice) {
            isValid = false; errorMsg = `Long SL must be BELOW ${currentPrice.toFixed(2)}`;
          }
          if (editMode.type === "TP" && price <= currentPrice) {
            isValid = false; errorMsg = `Long TP must be ABOVE ${currentPrice.toFixed(2)}`;
          }
        } else {
          // SHORT
          if (editMode.type === "SL" && price <= currentPrice) {
            isValid = false; errorMsg = `Short SL must be ABOVE ${currentPrice.toFixed(2)}`;
          }
          if (editMode.type === "TP" && price >= currentPrice) {
            isValid = false; errorMsg = `Short TP must be BELOW ${currentPrice.toFixed(2)}`;
          }
        }

        if (!isValid) {
          alert(`⚠️ Invalid ${editMode.type}!\n\n${errorMsg}\n\nPrevented placement to avoid instant exit.`);
          return prev;
        }

        return {
          ...prev,
          [editMode.symbol]: {
            ...pos,
            [editMode.type.toLowerCase()]: price
          }
        };
      });

      setEditMode(null);
    };

    if (chartsRef.current.es) {
      chartsRef.current.es.chart.unsubscribeClick();
      chartsRef.current.es.chart.subscribeClick((p: any) => handleChartClick(p, "es"));
    }
    if (chartsRef.current.nq) {
      chartsRef.current.nq.chart.unsubscribeClick();
      chartsRef.current.nq.chart.subscribeClick((p: any) => handleChartClick(p, "nq"));
    }

  }, [editMode]);

  useEffect(() => {
    if ((layout === "ES" || layout === "SPLIT") && chartContainerRefs.es.current) initChart("es", chartContainerRefs.es.current!);
    if ((layout === "NQ" || layout === "SPLIT") && chartContainerRefs.nq.current) initChart("nq", chartContainerRefs.nq.current!);
  }, [layout]);

  // --- Data Loading ---
  const loadData = async (dayToLoad: string, targetMin: number) => {
    if (!dayToLoad) return;
    setIsLoading(true);
    setIsPlaying(false);
    setCurrentMinute(targetMin);

    engineRef.current.globalTimeBig = 0n;
    engineRef.current.startMinute = MARKET_OPEN_MIN;
    engineRef.current.es = { ...engineRef.current.es, buffer: [], cursor: "0", done: false, lastLoadedIndex: -1, candle: null };
    engineRef.current.nq = { ...engineRef.current.nq, buffer: [], cursor: "0", done: false, lastLoadedIndex: -1, candle: null };

    Object.values(chartsRef.current).forEach((c) => { if (c) c.series.setData([]); });
    setPositions({});

    try {
      const [esData, nqData] = await Promise.all([
        fetchTicks("es", dayToLoad, "0", MARKET_OPEN_MIN),
        fetchTicks("nq", dayToLoad, "0", MARKET_OPEN_MIN),
      ]);

      engineRef.current.es.buffer = esData.ticks;
      engineRef.current.es.cursor = esData.nextCursor;
      engineRef.current.es.done = esData.done;

      engineRef.current.nq.buffer = nqData.ticks;
      engineRef.current.nq.cursor = nqData.nextCursor;
      engineRef.current.nq.done = nqData.done;

      const t1 = esData.ticks[0]?.ts ? BigInt(esData.ticks[0].ts) : null;
      const t2 = nqData.ticks[0]?.ts ? BigInt(nqData.ticks[0].ts) : null;

      let startNs = 0n;
      if (t1 && t2) startNs = t1 < t2 ? t1 : t2;
      else if (t1) startNs = t1;
      else if (t2) startNs = t2;

      if (startNs === 0n) {
        alert("No trading data available.");
        return;
      }

      engineRef.current.globalTimeBig = startNs;

      if (targetMin > MARKET_OPEN_MIN) {
        let caughtUp = false;
        const processSync = (key: "es" | "nq") => {
          const state = engineRef.current[key];
          const chart = chartsRef.current[key];
          if (!state.buffer.length) return;

          let idx = state.lastLoadedIndex + 1;
          while (idx < state.buffer.length) {
            const tick = state.buffer[idx];
            if (tick.m >= targetMin) {
              if (!caughtUp) {
                engineRef.current.globalTimeBig = BigInt(tick.ts);
                caughtUp = true;
              }
              break;
            }
            const price = tick.price;
            const timestamp = Number(BigInt(tick.ts) / 1000000000n);
            const minuteTime = (Math.floor(timestamp / 60) * 60) as Time;
            state.currentPrice = price;
            if (!state.candle) {
              state.candle = { time: minuteTime, open: price, high: price, low: price, close: price };
            } else if (state.candle.time !== minuteTime) {
              chart?.series.update(state.candle);
              state.candle = { time: minuteTime, open: price, high: price, low: price, close: price };
            } else {
              state.candle.high = Math.max(state.candle.high, price);
              state.candle.low = Math.min(state.candle.low, price);
              state.candle.close = price;
            }
            idx++;
          }
          state.lastLoadedIndex = idx - 1;
        }
        processSync("es");
        processSync("nq");
        if (engineRef.current.es.candle) chartsRef.current.es?.series.update(engineRef.current.es.candle);
        if (engineRef.current.nq.candle) chartsRef.current.nq?.series.update(engineRef.current.nq.candle);
      }
      updateClockDisplay(engineRef.current.globalTimeBig);
      setIsPlaying(true);
    } catch (e) { console.error("Load error", e); }
    finally { setIsLoading(false); }
  };

  const jumpTo1450 = () => { loadData(selectedDay, 14 * 60 + 50); setJumpHour(14); setJumpMin(50); };
  const jumpToSpecificTime = () => { loadData(selectedDay, jumpHour * 60 + jumpMin); };
  const handleDaySelect = (d: string) => { setSelectedDay(d); loadData(d, MARKET_OPEN_MIN); };

  // --- Engine ---
  const checkAndFetchMore = async () => {
    if (engineRef.current.loadingMore) return;
    const THRESHOLD = 10000;
    const needsEs = !engineRef.current.es.done && (engineRef.current.es.buffer.length - engineRef.current.es.lastLoadedIndex) < THRESHOLD;
    const needsNq = !engineRef.current.nq.done && (engineRef.current.nq.buffer.length - engineRef.current.nq.lastLoadedIndex) < THRESHOLD;
    if (!needsEs && !needsNq) return;

    engineRef.current.loadingMore = true;
    try {
      if (needsEs) {
        const data = await fetchTicks("es", selectedDay, engineRef.current.es.cursor, engineRef.current.startMinute);
        engineRef.current.es.buffer = [...engineRef.current.es.buffer, ...data.ticks];
        engineRef.current.es.cursor = data.nextCursor;
        engineRef.current.es.done = data.done;
      }
      if (needsNq) {
        const data = await fetchTicks("nq", selectedDay, engineRef.current.nq.cursor, engineRef.current.startMinute);
        engineRef.current.nq.buffer = [...engineRef.current.nq.buffer, ...data.ticks];
        engineRef.current.nq.cursor = data.nextCursor;
        engineRef.current.nq.done = data.done;
      }
    } catch (e) { console.error("Bg fetch", e); }
    finally { engineRef.current.loadingMore = false; }
  };

  const processInstrumentTick = (key: "es" | "nq", globalTime: bigint) => {
    const state = engineRef.current[key];
    const chart = chartsRef.current[key];
    if (!state.buffer.length || !chart) return;

    let idx = state.lastLoadedIndex + 1;
    let hasUpdates = false;

    while (idx < state.buffer.length) {
      const tick = state.buffer[idx];
      const tickTs = BigInt(tick.ts);
      if (tickTs > globalTime) break;

      const price = tick.price;
      const timestamp = Number(tickTs / 1000000000n);
      const minuteTime = (Math.floor(timestamp / 60) * 60) as Time;
      state.currentPrice = price;
      if (!state.candle) {
        state.candle = { time: minuteTime, open: price, high: price, low: price, close: price };
      } else if (state.candle.time !== minuteTime) {
        state.candle = { time: minuteTime, open: price, high: price, low: price, close: price };
      } else {
        state.candle.high = Math.max(state.candle.high, price);
        state.candle.low = Math.min(state.candle.low, price);
        state.candle.close = price;
      }
      chart.series.update(state.candle);
      hasUpdates = true;
      idx++;
    }
    state.lastLoadedIndex = idx - 1;
    return hasUpdates;
  };

  const updateClockDisplay = (tsNs: bigint) => {
    if (tsNs === 0n) return;
    const ms = Number(tsNs / 1000000n);
    const date = new Date(ms);
    const nyTime = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: 'America/New_York'
    }).format(date);
    setCurrentTimeDisplay(nyTime);
  };

  const updatePnL = () => {
    setPositions(prev => {
      const next = { ...prev };
      let changed = false;

      Object.keys(next).forEach(key => {
        const pos = next[key];
        const currentPrice = engineRef.current[key.toLowerCase() as "es" | "nq"].currentPrice;
        if (!currentPrice || currentPrice === 0) return;

        const inst = INSTRUMENTS[key.toLowerCase()];
        const multi = contractType === "MINI" ? inst.multiplierMini : inst.multiplierMicro;
        const diff = pos.side === "LONG" ? (currentPrice - pos.avgPrice) : (pos.avgPrice - currentPrice);
        pos.pnl = diff * multi * pos.size;

        // Execution Check
        if (pos.sl && ((pos.side === "LONG" && currentPrice <= pos.sl) || (pos.side === "SHORT" && currentPrice >= pos.sl))) {
          setAccountBalance(b => b + pos.pnl);
          delete next[key];
          updateChartLines(key, null);
          changed = true;
        } else if (pos.tp && ((pos.side === "LONG" && currentPrice >= pos.tp) || (pos.side === "SHORT" && currentPrice <= pos.tp))) {
          setAccountBalance(b => b + pos.pnl);
          delete next[key];
          updateChartLines(key, null);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  };

  const loop = (timestamp: number) => {
    if (!isPlaying) return;
    if (!engineRef.current.lastFrameTime) engineRef.current.lastFrameTime = timestamp;
    const deltaMs = timestamp - engineRef.current.lastFrameTime;
    engineRef.current.lastFrameTime = timestamp;

    const advanceNs = BigInt(Math.floor(deltaMs * 1_000_000 * playbackSpeed));
    engineRef.current.globalTimeBig += advanceNs;
    const currentGlobal = engineRef.current.globalTimeBig;

    updateClockDisplay(currentGlobal);
    processInstrumentTick("es", currentGlobal);
    processInstrumentTick("nq", currentGlobal);
    updatePnL();
    checkAndFetchMore();
    engineRef.current.animationFrameId = requestAnimationFrame(loop);
  };

  useEffect(() => {
    if (isPlaying) {
      engineRef.current.lastFrameTime = 0;
      engineRef.current.animationFrameId = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(engineRef.current.animationFrameId);
    }
    return () => cancelAnimationFrame(engineRef.current.animationFrameId);
  }, [isPlaying, playbackSpeed]);

  const handleOrder = (instrument: "es" | "nq", side: "LONG" | "SHORT") => {
    const currentPrice = engineRef.current[instrument].currentPrice;
    if (!currentPrice) return;

    const symKey = instrument.toUpperCase();
    setPositions(prev => {
      const existing = prev[symKey];
      const newPos = { ...existing };
      if (!existing) {
        return { ...prev, [symKey]: { symbol: symKey, side, avgPrice: currentPrice, size: orderSize, pnl: 0 } };
      }
      if (existing.side === side) {
        const totalCost = (existing.avgPrice * existing.size) + (currentPrice * orderSize);
        const totalSize = existing.size + orderSize;
        newPos.avgPrice = totalCost / totalSize;
        newPos.size = totalSize;
        return { ...prev, [symKey]: newPos };
      } else {
        if (existing.size > orderSize) {
          newPos.size = existing.size - orderSize;
          const closedPnL = (existing.side === "LONG" ? (currentPrice - existing.avgPrice) : (existing.avgPrice - currentPrice))
            * orderSize * (contractType === "MINI" ? INSTRUMENTS[instrument].multiplierMini : INSTRUMENTS[instrument].multiplierMicro);
          setAccountBalance(b => b + closedPnL);
          return { ...prev, [symKey]: newPos };
        } else if (existing.size === orderSize) {
          const closedPnL = (existing.side === "LONG" ? (currentPrice - existing.avgPrice) : (existing.avgPrice - currentPrice))
            * orderSize * (contractType === "MINI" ? INSTRUMENTS[instrument].multiplierMini : INSTRUMENTS[instrument].multiplierMicro);
          setAccountBalance(b => b + closedPnL);
          const next = { ...prev };
          delete next[symKey];
          updateChartLines(instrument, null);
          return next;
        } else {
          const closedPnL = (existing.side === "LONG" ? (currentPrice - existing.avgPrice) : (existing.avgPrice - currentPrice))
            * existing.size * (contractType === "MINI" ? INSTRUMENTS[instrument].multiplierMini : INSTRUMENTS[instrument].multiplierMicro);
          setAccountBalance(b => b + closedPnL);
          return { ...prev, [symKey]: { symbol: symKey, side: side, avgPrice: currentPrice, size: orderSize - existing.size, pnl: 0 } };
        }
      }
    });
  };

  const updateChartLines = (instrument: string, pos: Position | null) => {
    const chartObj = chartsRef.current[instrument];
    if (!chartObj) return;

    chartObj.lines.forEach(l => chartObj.series.removePriceLine(l));
    chartObj.lines = [];

    if (pos) {
      chartObj.lines.push(chartObj.series.createPriceLine({
        price: pos.avgPrice, color: "#3b82f6", lineWidth: 2, title: `${pos.side} ${pos.size}`
      }));
      if (pos.sl) {
        chartObj.lines.push(chartObj.series.createPriceLine({
          price: pos.sl, color: "#ef4444", lineWidth: 1, lineStyle: LineStyle.Dashed, title: "SL"
        }));
      }
      if (pos.tp) {
        chartObj.lines.push(chartObj.series.createPriceLine({
          price: pos.tp, color: "#10b981", lineWidth: 1, lineStyle: LineStyle.Dashed, title: "TP"
        }));
      }
    }
  };

  useEffect(() => {
    Object.keys(chartsRef.current).forEach(key => {
      const pos = positions[key.toUpperCase()];
      updateChartLines(key, pos || null);
    });
  }, [positions]);

  const currentDays = weeks.find(w => w.weekStart === selectedWeek)?.days || [];

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-200 overflow-hidden font-sans">

      {/* HEADER */}
      <header className="h-14 border-b border-slate-800 bg-slate-900 flex items-center px-4 justify-between shrink-0 z-30">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-blue-400 font-bold text-lg mr-4">
            <Activity className="w-5 h-5" />
            <span>GhostTrader</span>
          </div>

          <select value={selectedWeek} onChange={(e) => setSelectedWeek(e.target.value)} className="bg-slate-800 border-none text-xs text-slate-400 rounded w-32 outline-none">
            {weeks.map(w => <option key={w.weekStart} value={w.weekStart}>{w.weekStart}</option>)}
          </select>

          <div className="flex gap-1 overflow-x-auto max-w-[500px]">
            {currentDays.map(d => {
              const dateObj = new Date(d + "T12:00:00");
              const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
              const dayNum = dateObj.getDate();
              return (
                <button key={d} onClick={() => handleDaySelect(d)}
                  className={cn("px-2 py-1 rounded-md text-center min-w-[3rem]", selectedDay === d ? "bg-blue-600 text-white" : "text-slate-400 hover:bg-slate-800")}>
                  <div className="text-[9px] uppercase">{dayName}</div>
                  <div className="text-sm font-bold leading-none">{dayNum}</div>
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm bg-slate-800 px-3 py-1 rounded-lg border border-slate-700">
            <span className="text-slate-500 font-bold">NY TIME</span>
            <span className="font-mono text-yellow-400 font-bold text-lg">{currentTimeDisplay}</span>
          </div>
          <div className="text-right">
            <div className={cn("font-mono text-lg font-bold", accountBalance >= 100000 ? "text-green-400" : "text-red-400")}>
              ${accountBalance.toLocaleString('en-US', { minimumFractionDigits: 0 })}
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">

        {/* LEFT: CHARTS */}
        <div className="flex-1 relative flex flex-col bg-slate-950 border-r border-slate-800">
          {editMode && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-blue-600 text-white px-4 py-2 rounded-full shadow-lg animate-pulse font-bold pointer-events-none">
              Click chart to set {editMode.type} for {editMode.symbol}
            </div>
          )}

          <div className="absolute top-4 right-4 z-20 flex gap-1 bg-slate-900/80 backdrop-blur p-1 rounded-lg border border-slate-700">
            {["ES", "NQ", "SPLIT"].map(l => (
              <button key={l} onClick={() => setLayout(l as any)}
                className={cn("px-3 py-1 rounded text-xs font-bold transition-all", layout === l ? "bg-blue-600 text-white" : "text-slate-400 hover:text-white")}>
                {l}
              </button>
            ))}
          </div>

          <div className="flex-1 flex w-full h-full cursor-crosshair">
            <div className={cn("flex-1 h-full relative border-r border-slate-800", (layout === "NQ") && "hidden")}>
              <div ref={chartContainerRefs.es} className="w-full h-full" />
            </div>
            <div className={cn("flex-1 h-full relative", (layout === "ES") && "hidden")}>
              <div ref={chartContainerRefs.nq} className="w-full h-full" />
            </div>
          </div>
        </div>

        {/* RIGHT: TRADING PANEL */}
        <div className="w-80 bg-slate-900 flex flex-col shrink-0 border-l border-slate-800 z-20 shadow-xl">
          <div className="p-4 border-b border-slate-800 space-y-6">

            {/* 1. Playback Controls */}
            <div className="bg-slate-800/50 p-3 rounded-xl border border-slate-700/50">
              <h3 className="text-[10px] font-bold text-slate-500 uppercase mb-3 flex justify-between">
                <span>Simulation Control</span>
              </h3>

              <div className="flex items-center gap-3 mb-4">
                <button onClick={() => setIsPlaying(!isPlaying)} className="flex-1 h-10 bg-blue-600 hover:bg-blue-500 rounded flex items-center justify-center text-white transition-all">
                  {isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
                </button>
              </div>

              <div className="space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400">Speed (Arrows ↑/↓)</span>
                  <span className="font-mono text-blue-400">{playbackSpeed}x</span>
                </div>
                <input
                  type="range" min="1" max="500" step="5"
                  value={playbackSpeed} onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                  className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />

                <div className="flex items-center gap-2 pt-2 border-t border-slate-700/50">
                  <div className="flex items-center bg-slate-900 rounded border border-slate-700 overflow-hidden flex-1">
                    <input type="number" min="9" max="16" value={jumpHour} onChange={(e) => setJumpHour(Number(e.target.value))} className="w-full bg-transparent text-center text-sm p-1 outline-none" placeholder="HH" />
                    <span className="text-slate-500">:</span>
                    <input type="number" min="0" max="59" value={jumpMin} onChange={(e) => setJumpMin(Number(e.target.value))} className="w-full bg-transparent text-center text-sm p-1 outline-none" placeholder="MM" />
                  </div>
                  <button onClick={jumpToSpecificTime} className="bg-slate-700 hover:bg-slate-600 text-white p-1.5 rounded transition-colors" title="Jump">
                    <RotateCcw size={16} />
                  </button>
                </div>
                <button onClick={jumpTo1450} className="w-full flex items-center justify-center gap-2 bg-slate-700/50 hover:bg-slate-700 text-xs text-slate-300 py-1.5 rounded transition-colors border border-slate-700">
                  <FastForward size={12} />
                  Jump to 14:50
                </button>
              </div>
            </div>

            {/* 2. Trading Buttons */}
            <div>
              <div className="flex bg-slate-800 p-1 rounded-lg mb-4">
                <button onClick={() => setContractType("MINI")} className={cn("flex-1 py-1.5 text-xs font-bold rounded transition-colors", contractType === "MINI" ? "bg-slate-600 text-white" : "text-slate-400")}>MINI</button>
                <button onClick={() => setContractType("MICRO")} className={cn("flex-1 py-1.5 text-xs font-bold rounded transition-colors", contractType === "MICRO" ? "bg-slate-600 text-white" : "text-slate-400")}>MICRO</button>
              </div>

              <div className="mb-4">
                <label className="text-[10px] uppercase text-slate-500 font-bold block mb-1">Order Qty</label>
                <input type="number" min="1" value={orderSize} onChange={(e) => setOrderSize(Number(e.target.value))} className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-sm font-mono text-center outline-none focus:border-blue-500" />
              </div>

              <div className="space-y-4">
                {(layout === "ES" || layout === "SPLIT") && (
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={() => handleOrder("es", "LONG")} className="bg-green-500/10 hover:bg-green-500/20 text-green-400 border border-green-500/30 py-3 rounded-lg font-bold text-sm transition-all flex flex-col items-center">
                      <span>BUY ES</span>
                    </button>
                    <button onClick={() => handleOrder("es", "SHORT")} className="bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 py-3 rounded-lg font-bold text-sm transition-all flex flex-col items-center">
                      <span>SELL ES</span>
                    </button>
                  </div>
                )}
                {(layout === "NQ" || layout === "SPLIT") && (
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={() => handleOrder("nq", "LONG")} className="bg-green-500/10 hover:bg-green-500/20 text-green-400 border border-green-500/30 py-3 rounded-lg font-bold text-sm transition-all flex flex-col items-center">
                      <span>BUY NQ</span>
                    </button>
                    <button onClick={() => handleOrder("nq", "SHORT")} className="bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 py-3 rounded-lg font-bold text-sm transition-all flex flex-col items-center">
                      <span>SELL NQ</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 bg-slate-900">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">Open Positions</h3>
            <div className="space-y-3">
              {Object.values(positions).map(pos => (
                <div key={pos.symbol} className="bg-slate-800 p-3 rounded-lg border-l-4 border-l-blue-500 shadow-sm relative group">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <div className="text-sm font-bold text-white flex gap-2 items-center">
                        <span>{pos.symbol}</span>
                        <span className={cn("px-1.5 py-0.5 rounded text-[10px]", pos.side === "LONG" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400")}>{pos.side} {pos.size}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono mt-1">Avg: {pos.avgPrice.toFixed(2)}</div>
                    </div>
                    <div className={cn("text-lg font-mono font-bold", pos.pnl >= 0 ? "text-green-400" : "text-red-400")}>
                      {pos.pnl >= 0 ? "+" : ""}{pos.pnl.toFixed(0)}
                    </div>
                  </div>

                  {/* NEW CHART-BASED SL/TP BUTTONS */}
                  <div className="flex gap-2 mt-2 pt-2 border-t border-slate-700/50">
                    <button
                      onClick={() => setEditMode({ symbol: pos.symbol, type: "SL" })}
                      className={cn("flex-1 py-1 text-xs rounded border transition-colors flex items-center justify-center gap-1", pos.sl ? "border-red-500/50 text-red-400 bg-red-500/10" : "border-slate-700 text-slate-400 hover:border-red-500 hover:text-red-400")}
                    >
                      <ShieldAlert size={10} />
                      {pos.sl ? pos.sl.toFixed(2) : "Add SL"}
                    </button>
                    <button
                      onClick={() => setEditMode({ symbol: pos.symbol, type: "TP" })}
                      className={cn("flex-1 py-1 text-xs rounded border transition-colors flex items-center justify-center gap-1", pos.tp ? "border-green-500/50 text-green-400 bg-green-500/10" : "border-slate-700 text-slate-400 hover:border-green-500 hover:text-green-400")}
                    >
                      <Target size={10} />
                      {pos.tp ? pos.tp.toFixed(2) : "Add TP"}
                    </button>
                  </div>
                </div>
              ))}
              {Object.keys(positions).length === 0 && (
                <div className="text-slate-600 text-xs text-center py-6 italic">No active trades</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}