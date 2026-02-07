document.getElementById('calibrateBtn').addEventListener('click', () => {
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, {action: "START_CALIBRATION"});
    window.close();
  });
});

document.getElementById('toggleBtn').addEventListener('click', () => {
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, {action: "TOGGLE_SIDEBAR"});
  });
});