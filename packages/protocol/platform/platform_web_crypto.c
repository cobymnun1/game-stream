#include <stdbool.h>
#include <stdlib.h>

#include "Limelight-internal.h"

extern int crypto_encrypt(int algorithm, int flags,
  const unsigned char* key, int key_length,
  const unsigned char* iv, int iv_length,
  unsigned char* tag, int tag_length,
  unsigned char* input_data, int input_data_length,
  unsigned char* output_data, int* output_data_length);

extern int crypto_decrypt(int algorithm, int flags,
  const unsigned char* key, int key_length,
  const unsigned char* iv, int iv_length,
  const unsigned char* tag, int tag_length,
  const unsigned char* input_data, int input_data_length,
  unsigned char* output_data, int* output_data_length);

extern void crypto_random(unsigned char* data, int length);

bool PltEncryptMessage(PPLT_CRYPTO_CONTEXT ctx, int algorithm, int flags,
                       unsigned char* key, int keyLength,
                       unsigned char* iv, int ivLength,
                       unsigned char* tag, int tagLength,
                       unsigned char* inputData, int inputDataLength,
                       unsigned char* outputData, int* outputDataLength) {
    (void)ctx;
    return crypto_encrypt(algorithm, flags, key, keyLength, iv, ivLength, tag, tagLength,
        inputData, inputDataLength, outputData, outputDataLength) == 1;
}

bool PltDecryptMessage(PPLT_CRYPTO_CONTEXT ctx, int algorithm, int flags,
                       unsigned char* key, int keyLength,
                       unsigned char* iv, int ivLength,
                       unsigned char* tag, int tagLength,
                       unsigned char* inputData, int inputDataLength,
                       unsigned char* outputData, int* outputDataLength) {
    (void)ctx;
    return crypto_decrypt(algorithm, flags, key, keyLength, iv, ivLength, tag, tagLength,
        inputData, inputDataLength, outputData, outputDataLength) == 1;
}

PPLT_CRYPTO_CONTEXT PltCreateCryptoContext(void) {
    PPLT_CRYPTO_CONTEXT ctx = calloc(1, sizeof(*ctx));
    return ctx;
}

void PltDestroyCryptoContext(PPLT_CRYPTO_CONTEXT ctx) {
    free(ctx);
}

void PltGenerateRandomData(unsigned char* data, int length) {
    crypto_random(data, length);
}
