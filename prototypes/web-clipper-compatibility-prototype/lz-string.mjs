// Compression-compatible subset of LZ-String 1.5.0.
// Original copyright (c) 2013 Pieroxy, distributed under WTFPL v2.

function compress(uncompressed, bitsPerCharacter, characterForValue) {
  if (uncompressed == null) return '';
  let value;
  const dictionary = {};
  const dictionaryToCreate = {};
  let current = '';
  let currentAndCharacter = '';
  let word = '';
  let enlargeIn = 2;
  let dictionarySize = 3;
  let numberOfBits = 2;
  const data = [];
  let dataValue = 0;
  let dataPosition = 0;

  const writeBit = (bit) => {
    dataValue = (dataValue << 1) | bit;
    if (dataPosition === bitsPerCharacter - 1) {
      dataPosition = 0;
      data.push(characterForValue(dataValue));
      dataValue = 0;
    } else {
      dataPosition += 1;
    }
  };
  const writeValue = (input, bits) => {
    let remaining = input;
    for (let index = 0; index < bits; index += 1) {
      writeBit(remaining & 1);
      remaining >>= 1;
    }
  };
  const enlarge = () => {
    enlargeIn -= 1;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numberOfBits;
      numberOfBits += 1;
    }
  };
  const writeWord = () => {
    if (Object.hasOwn(dictionaryToCreate, word)) {
      if (word.charCodeAt(0) < 256) {
        writeValue(0, numberOfBits);
        writeValue(word.charCodeAt(0), 8);
      } else {
        writeValue(1, numberOfBits);
        writeValue(word.charCodeAt(0), 16);
      }
      enlarge();
      delete dictionaryToCreate[word];
    } else {
      writeValue(dictionary[word], numberOfBits);
    }
    enlarge();
  };

  for (let index = 0; index < uncompressed.length; index += 1) {
    current = uncompressed.charAt(index);
    if (!Object.hasOwn(dictionary, current)) {
      dictionary[current] = dictionarySize;
      dictionarySize += 1;
      dictionaryToCreate[current] = true;
    }

    currentAndCharacter = word + current;
    if (Object.hasOwn(dictionary, currentAndCharacter)) {
      word = currentAndCharacter;
    } else {
      writeWord();
      dictionary[currentAndCharacter] = dictionarySize;
      dictionarySize += 1;
      word = String(current);
    }
  }

  if (word !== '') writeWord();
  value = 2;
  writeValue(value, numberOfBits);
  while (true) {
    dataValue <<= 1;
    if (dataPosition === bitsPerCharacter - 1) {
      data.push(characterForValue(dataValue));
      break;
    }
    dataPosition += 1;
  }
  return data.join('');
}

export function compressToUTF16(input) {
  if (input == null) return '';
  return `${compress(input, 15, (value) => String.fromCharCode(value + 32))} `;
}
