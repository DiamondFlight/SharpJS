import type { Sounding } from '../index.js';

type FetchLike = (url: string) => Promise<Response>;
type ArchiveTime = Date | string | number;

export interface ArchiveStation {
  code: string;
  city: string;
  state: string;
  country: string;
  lat: number;
  lon: number;
}

export interface AcarsArchiveReport {
  station: string;
  time: number;
  url: string;
}

export const BUFKIT_MODELS: string[];
export function fetchIemRaob(query: { station: string; time: Date | string | number; location?: { lat: number; lon: number } | false; fetch?: FetchLike }): Promise<Sounding>;
export function fetchIemBufkit(query: { model?: string; station: string; run: Date | string | number; forecastHour?: number; location?: { lat: number; lon: number }; fetch?: FetchLike }): Promise<Sounding>;
export function fetchIemBufkitForecasts(query: { model?: string; station: string; run: Date | string | number; location?: { lat: number; lon: number }; fetch?: FetchLike }): Promise<Sounding[]>;
export function listAcarsArchive(query: {
  time: ArchiveTime;
  hours?: number;
  station?: string;
  baseUrl?: string;
  fetch?: FetchLike;
}): Promise<AcarsArchiveReport[]>;
export function fetchAcarsArchive(query: {
  time: ArchiveTime;
  hours?: number;
  station?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  onSounding?: (sounding: Sounding, progress: { index: number; total: number; station: string }) => void;
}): Promise<Sounding[]>;
export function fetchNexradVwp(query: { radar: string; time?: ArchiveTime; background?: Sounding; fetch?: FetchLike }): Promise<Sounding>;
export function fetchNexradVwpArchive(query: {
  radar: string;
  start: ArchiveTime;
  end: ArchiveTime;
  background?: Sounding;
  fetch?: FetchLike;
  onVolume?: (sounding: Sounding, progress: { index: number; total: number }) => void;
}): Promise<Sounding[]>;
export function fetchNexradVwpRadarStations(query?: { fetch?: FetchLike }): Promise<ArchiveStation[]>;
export function raobStationLocation(station: string, fetch?: FetchLike): Promise<{ lat: number; lon: number } | null>;
