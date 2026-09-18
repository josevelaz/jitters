document.documentElement.classList.add("has-js");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const header = document.querySelector(".site-header");
const toggle = document.querySelector(".menu-toggle");
const nav = document.getElementById("site-nav");

function setMenu(open) {
  if (!toggle || !header) return;
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  header.classList.toggle("is-open", open);
}

toggle?.addEventListener("click", () => {
  setMenu(toggle.getAttribute("aria-expanded") !== "true");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && toggle?.getAttribute("aria-expanded") === "true") {
    setMenu(false);
    toggle.focus();
  }
});

nav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => setMenu(false));
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.left = "-9999px";
    document.body.append(field);
    field.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      field.remove();
    }
  }
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  const block = button.closest(".code-block");
  const code = block?.querySelector("pre code");
  const status = block?.querySelector("[data-copy-status]");
  const label = button.querySelector(".copy-button__label") ?? button;
  button.addEventListener("click", async () => {
    const text = code?.textContent ?? "";
    const ok = await copyText(text);
    label.textContent = ok ? "Copied" : "Select text";
    if (status) {
      status.textContent = ok ? "Copied to clipboard" : "Copy failed. Select the text instead.";
    }
    window.setTimeout(() => {
      label.textContent = "Copy";
      if (status) status.textContent = "";
    }, 1600);
  });
});

const tocLinks = [...document.querySelectorAll(".section-nav__list a")];
const sections = tocLinks
  .map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))))
  .filter(Boolean);

if (sections.length && "IntersectionObserver" in window) {
  const visible = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      const current =
        sections.find((section) => visible.has(section.id)) ??
        sections.reduce((best, section) => {
          const top = Math.abs(section.getBoundingClientRect().top - 120);
          const bestTop = Math.abs(best.getBoundingClientRect().top - 120);
          return top < bestTop ? section : best;
        });
      tocLinks.forEach((link) => {
        if (link.hash === `#${current.id}`) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    },
    { rootMargin: "-18% 0px -70% 0px", threshold: [0, 0.25, 1] },
  );
  sections.forEach((section) => observer.observe(section));
}

const reel = document.querySelector("[data-demo]");
const replay = document.querySelector("[data-demo-replay]");

function playReel() {
  if (!reel || reducedMotion) return;
  reel.classList.remove("is-playing");
  void reel.offsetWidth;
  reel.classList.add("is-playing");
}

if (reel && !reducedMotion && "IntersectionObserver" in window) {
  const demoObserver = new IntersectionObserver(
    (entries, obs) => {
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)) {
        playReel();
        obs.disconnect();
      }
    },
    { threshold: [0.5] },
  );
  demoObserver.observe(reel);
}

replay?.addEventListener("click", playReel);
