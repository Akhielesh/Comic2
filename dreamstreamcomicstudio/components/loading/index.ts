/**
 * App-level loading (the boot screen, in-content loaders, route fallbacks, the wake hint). In-studio
 * skeletons belong to each studio; these are the screens between the first HTML paint and a page.
 */
export { AppLoader, ContentLoader, BOOT_LABEL, DEFER_IN, FILL_BELOW_HEADER, FILL_VIEWPORT, type AppLoaderProps, type ContentLoaderProps } from './AppLoader';
export { RouteFallback, ROUTE_LOADING, DEFAULT_ROUTE_LOADING, routeLoadingFor, type RouteLoading, type RouteShape } from './RouteFallback';
export { WakeHint, WAKE_HINT_TEXT, WAKE_HINT_DETAIL } from './WakeHint';
export { trackBackendWake, useBackendWake, getBackendWake, subscribeBackendWake, WAKE_HINT_AFTER_MS, type BackendWake } from './backendWake';
export { BOOT, SPLASH_BAR_SELECTOR } from './bootGeometry';
export { splashSweepDelay } from './bootPhase';
