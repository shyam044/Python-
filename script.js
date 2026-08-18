(() => {
  'use strict';

  // Folder convention:
  // lessons/lesson1.html, lessons/lesson2.html, lessons/lesson3.html, ...
  // Keep lesson numbering contiguous. The loader discovers lessons asynchronously,
  // so the first paint does not wait for every lesson file.
  const CONFIG = Object.freeze({
    lessonPath: 'lessons/lesson',
    extension: '.html',
    maxLessonsToProbe: 1000,
    stopAfterConsecutiveMisses: 4,
    requestTimeoutMs: 3500,
    initialRenderCount: 12,
    cacheBust: true
  });

  const FALLBACK_LESSONS = Object.freeze([
    {
      number: 1,
      title: 'Python print()',
      description: 'Learn how Python print() displays output with your first Hello World example.',
      bodyText: 'python print output hello world',
      url: 'lessons/lesson1.html'
    }
  ]);

  const state = {
    lessons: [],
    searchQuery: '',
    controller: null,
    nextNumber: 1,
    consecutiveMisses: 0,
    loading: true
  };

  const els = {
    list: document.getElementById('lesson-list'),
    status: document.getElementById('status'),
    empty: document.getElementById('empty-state'),
    search: document.getElementById('lesson-search'),
    clear: document.getElementById('clear-search'),
    count: document.getElementById('lesson-count-number'),
    year: document.getElementById('year')
  };

  const escapeHtml = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const cleanText = (value) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

  const deriveLessonMeta = (doc, number, url) => {
    const title = cleanText(
      doc.querySelector('meta[name="lesson-title"]')?.getAttribute('content') ||
      doc.querySelector('h1')?.textContent ||
      doc.title ||
      `Python Lesson ${number}`
    );

    const description = cleanText(
      doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="lesson-description"]')?.getAttribute('content') ||
      doc.querySelector('main p')?.textContent ||
      'Learn this Python concept with examples and explanations.'
    );

    const bodyText = cleanText(doc.body?.textContent || '').slice(0, 14000).toLowerCase();

    return { number, title: title.slice(0, 140), description: description.slice(0, 240), bodyText, url };
  };

  const fetchLesson = async (number, signal) => {
    let url = `${CONFIG.lessonPath}${number}${CONFIG.extension}`;
    if (CONFIG.cacheBust) {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}v=${Date.now()}`;
    }
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'same-origin',
      signal
    });

    if (!response.ok) return null;

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return deriveLessonMeta(doc, number, url);
  };

  const similarityScore = (lesson, query) => {
    if (!query) return 0;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    let score = 0;

    for (const term of terms) {
      if (lesson.title.toLowerCase().includes(term)) score += 8;
      if (lesson.description.toLowerCase().includes(term)) score += 4;
      if (lesson.bodyText.includes(term)) score += 1;
    }
    return score;
  };

  const getFilteredLessons = () => {
    const query = cleanText(state.searchQuery).toLowerCase();
    if (!query) return state.lessons;

    return state.lessons
      .map((lesson) => ({ lesson, score: similarityScore(lesson, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.lesson.number - b.lesson.number)
      .map((item) => item.lesson);
  };

  const render = () => {
    const lessons = getFilteredLessons();
    const fragment = document.createDocumentFragment();

    els.list.replaceChildren();
    els.count.textContent = String(state.lessons.length);

    for (const lesson of lessons) {
      const article = document.createElement('article');
      article.className = 'lesson-card';
      article.innerHTML = `
        <span class="lesson-kicker">Lesson ${escapeHtml(lesson.number)}</span>
        <h3>${escapeHtml(lesson.title)}</h3>
        <p>${escapeHtml(lesson.description)}</p>
        <a class="lesson-link" href="${encodeURI(lesson.url)}">Open lesson <span aria-hidden="true">→</span></a>
      `;
      fragment.append(article);
    }

    els.list.append(fragment);
    els.empty.hidden = lessons.length !== 0 || state.lessons.length === 0;

    if (state.loading) {
      els.status.textContent = `Loaded ${state.lessons.length} lesson${state.lessons.length === 1 ? '' : 's'}…`;
    } else if (state.lessons.length === 0) {
      els.status.textContent = 'No lessons were found yet.';
    } else if (state.searchQuery) {
      els.status.textContent = `${lessons.length} matching lesson${lessons.length === 1 ? '' : 's'}.`;
    } else {
      els.status.textContent = `${state.lessons.length} lesson${state.lessons.length === 1 ? '' : 's'} available.`;
    }

    els.clear.hidden = !state.searchQuery;
  };

  const updateSearchUrl = (query) => {
    try {
      const url = new URL(window.location.href);
      if (query) url.searchParams.set('q', query);
      else url.searchParams.delete('q');
      history.replaceState(null, '', url);
    } catch (_) {
      // Ignore environments where history manipulation is unavailable.
    }
  };

  const handleSearch = (value) => {
    state.searchQuery = cleanText(value).slice(0, 120);
    updateSearchUrl(state.searchQuery);
    render();
  };

  const loadLessons = async () => {
    state.controller?.abort();
    state.controller = new AbortController();

    const addLesson = (lesson) => {
      if (!lesson) return;
      if (!state.lessons.some((existing) => existing.number === lesson.number)) {
        state.lessons.push(lesson);
      }
    };

    // Make Lesson 1 available even when index.html is opened directly from the filesystem.
    FALLBACK_LESSONS.forEach(addLesson);
    state.lessons.sort((a, b) => a.number - b.number);
    render();

    const batchSize = 6;
    let localNext = 1;
    let misses = 0;

    while (localNext <= CONFIG.maxLessonsToProbe && misses < CONFIG.stopAfterConsecutiveMisses) {
      const numbers = Array.from({ length: batchSize }, (_, i) => localNext + i)
        .filter((n) => n <= CONFIG.maxLessonsToProbe);

      const results = await Promise.allSettled(numbers.map(async (number) => {
        const timeoutController = new AbortController();
        const timeout = window.setTimeout(() => timeoutController.abort(), CONFIG.requestTimeoutMs);
        try {
          const lesson = await fetchLesson(number, timeoutController.signal);
          return { number, lesson };
        } catch (_) {
          return { number, lesson: null };
        } finally {
          window.clearTimeout(timeout);
        }
      }));

      const ordered = results
        .map((result, index) => result.status === 'fulfilled'
          ? result.value
          : { number: numbers[index], lesson: null })
        .sort((a, b) => a.number - b.number);

      for (const item of ordered) {
        localNext = Math.max(localNext, item.number + 1);
        if (item.lesson) {
          addLesson(item.lesson);
          misses = 0;
        } else {
          misses += 1;
        }
      }

      state.lessons.sort((a, b) => a.number - b.number);
      render();
      await new Promise((resolve) => requestAnimationFrame(resolve));

      if (window.location.protocol === 'file:') break;
    }

    state.loading = false;
    render();
  };

  const init = () => {
    if (!els.list || !els.search) return;
    els.year.textContent = String(new Date().getFullYear());

    try {
      const urlQuery = new URL(window.location.href).searchParams.get('q');
      if (urlQuery) {
        els.search.value = urlQuery;
        state.searchQuery = cleanText(urlQuery).slice(0, 120);
      }
    } catch (_) {}

    els.search.addEventListener('input', (event) => handleSearch(event.target.value));
    els.clear.addEventListener('click', () => {
      els.search.value = '';
      handleSearch('');
      els.search.focus();
    });

    // Don't make the search index block page rendering.
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(() => loadLessons(), { timeout: 1200 });
    } else {
      window.setTimeout(loadLessons, 0);
    }

    render();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
