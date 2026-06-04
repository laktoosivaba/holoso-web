fetch('https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide-lock.json')
  .then(r => r.json())
  .then(lock => {
    console.log('pytest in lock?', !!lock.packages['pytest']);
    console.log('jaxtyping in lock?', !!lock.packages['jaxtyping']);
  });
