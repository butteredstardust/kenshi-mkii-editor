// Entry point. The app shell (boot, render, refresh, wire) lives in
// modules/system/shell.mjs; every tab's markup and wiring lives under
// modules/features/. This file only starts it.
import { start } from './modules/system/shell.mjs';

start();
