# English OCR data

`eng.traineddata.gz` is Tesseract's English model for the LSTM engine, the `4.0.0_best_int` build
tesseract.js uses by default. It is bundled so OCR never downloads anything at run time:
`src/ocr.ts` points `langPath` at this folder.

- Source: `@tesseract.js-data/eng` 1.0.0 (`4.0.0_best_int/eng.traineddata.gz`), an integer build of
  tesseract-ocr's `tessdata_best` English model.
- SHA-256: `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91`
- Size: 2,952,873 bytes.
- Licence: Apache-2.0, the licence of tesseract-ocr's trained data; the text is in `LICENSE`.
