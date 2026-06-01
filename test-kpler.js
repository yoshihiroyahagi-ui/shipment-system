const API_KEY = 'VFlHSE5sRkcyOHF0SnEwNDJ4YlZKZE5ZOE1NOWRBT1k6VEF3X0U5QWoycTVjUUNPUk1NWUhIREZrcGItbzhrdGlESFg4YlNJaHNIUUFETzJDWDlpVndYTXBwUW9hSUdrbw=='.trim();

async function test() {
  const url = 'https://api.kpler.com/v2/maritime/ais-latest?format=json&limit=1';

  const res = await fetch(url, {
    method: 'GET',
    headers: {
  Authorization: API_KEY,
  Accept: 'application/json'
}
  });

  console.log('status:', res.status);
  console.log(await res.text());
}

test().catch(console.error);