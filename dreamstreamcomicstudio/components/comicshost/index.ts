// Comic Studio on its own host (comics.dreamstreamstudio.ai): boot hook, landing, header and routing rules.
export { useComicsHost, type ComicsHostBoot, type UseComicsHostOptions } from './useComicsHost';
export { ComicsLanding, type ComicsLandingProps } from './ComicsLanding';
export { ComicsHeader, type ComicsHeaderProps, type ComicsSectionId } from './ComicsHeader';
export { ComicsMark } from './ComicsMark';
export { ComicPageSpecimen, SPECIMEN_LINES, SPECIMEN_LOOKS, type ComicPageSpecimenProps, type SpecimenLayout } from './ComicPageSpecimen';
export { StudioPreview } from './StudioPreview';
export { COMICS_CHROME_VIEWS, OFF_HOST_VIEWS, comicsChromeFor, offHostUrlForView, shouldBootToDashboard, type ComicsChrome, type ComicsHeaderCurrent } from './hostRouting';
