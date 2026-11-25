// reader-page.js — the reader's own page (reader.html): what the page starts with (boot.js), then the
// reader. startReader() returns the reader's stop, for whatever mounts it otherwise.
import './boot.js';
import { startReader } from './reader.js';

startReader();
