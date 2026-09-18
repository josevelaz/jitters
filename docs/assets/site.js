document.querySelectorAll("pre").forEach((pre) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy";
  btn.textContent = "Copy";
  btn.addEventListener("click", async () => {
    const text = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.textContent = "Copy";
      }, 1400);
    } catch {
      btn.textContent = "Failed";
    }
  });
  pre.append(btn);
});
