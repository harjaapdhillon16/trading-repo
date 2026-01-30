export type Instrument = "es" | "nq";

export type Tick = {
  ts: string;
  price: number;
  volume: number;
  m: number;
  instrument: Instrument;
};

export type WeekAvailability = {
  weekStart: string;
  days: string[];
};
