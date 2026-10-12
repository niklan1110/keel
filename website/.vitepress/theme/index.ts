// The default theme without its bundled Inter font: the site uses Keel's own fonts.
import DefaultTheme from 'vitepress/theme-without-fonts';
import type { Theme } from 'vitepress';
import { useRoute } from 'vitepress';
import { nextTick, onMounted, watch } from 'vue';
import mediumZoom, { type Zoom } from 'medium-zoom';
import '@fontsource/bricolage-grotesque/400.css';
import '@fontsource/bricolage-grotesque/500.css';
import '@fontsource/bricolage-grotesque/600.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import './custom.css';
import './landing.css';
import KIcon from './components/KIcon.vue';

// Screenshots in the docs open full size on click (Esc, scroll or click to close).
// Images inside links keep their link; add class="no-zoom" to opt one out.
const ZOOMABLE = '.vp-doc img:not(a img):not(.no-zoom)';

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('KIcon', KIcon);
  },
  setup() {
    const route = useRoute();
    let zoom: Zoom | undefined;
    const attach = () => {
      zoom ??= mediumZoom({ background: 'var(--keel-zoom-bg)', margin: 24 });
      zoom.detach();
      zoom.attach(ZOOMABLE);
    };
    onMounted(attach);
    watch(
      () => route.path,
      () => nextTick(attach),
    );
  },
};

export default theme;
