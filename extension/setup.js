// Asks for the microphone once in a normal tab, where Firefox can show its
// prompt. The permission belongs to the extension, so the sidebar gets it too.
const result = document.getElementById("result");
document.getElementById("allow").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    result.textContent = "The microphone is allowed. Close this tab and use the sidebar.";
    result.dataset.state = "allowed";
  } catch (error) {
    result.textContent = `Firefox did not allow the microphone (${error.name}). Click the microphone icon in the address bar to change it.`;
    result.dataset.state = "denied";
  }
});
