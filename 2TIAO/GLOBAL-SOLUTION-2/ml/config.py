"""Onde ficam os dados e os modelos. No container: /app/data e /app/ml/modelos (volumes)."""
import os
from pathlib import Path

PACOTE = Path(__file__).resolve().parent
RAIZ = PACOTE.parent


def modelos_dir() -> Path:
    return Path(os.environ.get("ML_MODELOS", PACOTE / "modelos"))


def dados_csv() -> Path:
    return Path(os.environ.get("ML_DADOS", RAIZ / "data" / "treino" / "metricas.csv"))
