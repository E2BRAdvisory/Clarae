import '@testing-library/jest-dom/vitest';
import { installDomShims } from '../editor/live/domShims';
import { installWailsMock } from './wails-mock';

installWailsMock();
installDomShims();
