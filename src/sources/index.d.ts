import type { Sounding } from '../index.js';

type FetchLike = (url: string) => Promise<Response>;

export const BUFKIT_MODELS: string[];
export function fetchIemRaob(query: { station: string; time: Date | string | number; location?: { lat: number; lon: number } | false; fetch?: FetchLike }): Promise<Sounding>;
export function fetchIemBufkit(query: { model?: string; station: string; run: Date | string | number; forecastHour?: number; fetch?: FetchLike }): Promise<Sounding>;
export function fetchIemBufkitForecasts(query: { model?: string; station: string; run: Date | string | number; fetch?: FetchLike }): Promise<Sounding[]>;
export function fetchNexradVwp(query: { radar: string; time?: Date | string | number; background?: Sounding; fetch?: FetchLike }): Promise<Sounding>;
export function fetchNexradVwpArchive(query: {
  radar: string;
  start: Date | string | number;
  end: Date | string | number;
  background?: Sounding;
  fetch?: FetchLike;
  onVolume?: (sounding: Sounding, progress: { index: number; total: number }) => void;
}): Promise<Sounding[]>;
export function raobStationLocation(station: string, fetch?: FetchLike): Promise<{ lat: number; lon: number } | null>;
