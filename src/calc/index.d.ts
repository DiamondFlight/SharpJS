// Low-level calculation functions keep the loose shapes of the original SharpJS code.
export declare function computeThermo(sound: unknown): any;
export declare function computeWindParams(sounding: unknown, info: unknown, parcel: unknown, stormMotion: { x: number; y: number }, windParams?: object): any;
export declare const ROCP: number;
export declare const RMISSD: number;
export declare function LiftParcel(sound: unknown, type: 'SB' | 'ML' | 'MU' | 'CU' | 'EFF', start?: number, doEcape?: boolean): any;
export declare function GetBM(sound: unknown): any;
export declare function GetSRH(sound: unknown, bottom: number, top: number, type: 'Pres' | 'Hght', stormMotion?: unknown): { SRHP: number; SRHM: number };
export declare function GetLayerByPres(sound: unknown, level: number | 'SFC' | 'Last', type?: string): any;
export declare function GetLayerByHght(sound: unknown, level: number | 'SFC', addTo?: boolean): any;
export declare function GetParams(info: unknown, type: string): any;
export declare function wetbulb(pres: number, temp: number, dew: number): number;
export declare function thetae(pres: number, temp: number, dew: number): number;
export declare function RelHum(temp: number, dew: number): number;
export declare function DewFromTRh(temp: number, rh: number): number;
