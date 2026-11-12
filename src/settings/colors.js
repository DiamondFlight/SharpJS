export let mode = false;
export let Mode = 'dark_mode';

export function setColorMode(darkMode) {
  mode = !!darkMode;
  Mode = darkMode ? 'dark_mode' : 'light_mode';
}

export function getColorMode(){
    return mode;
}