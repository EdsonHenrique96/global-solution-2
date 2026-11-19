import json
import math
import re
import shutil

from fastapi.testclient import TestClient

from ml.api import app
from ml.treinar import treinar

client = TestClient(app)
DOZE = [f"I{a}>I{b}" for a, b in [(11, 12), (12, 13), (13, 14), (21, 22), (22, 23), (23, 24), (31, 32), (32, 33), (33, 34), (41, 42), (42, 43), (43, 44)]]


def trecho(v=30.0, f=6.0, d=20.0):
    return {"v": [v] * 10, "f": [f] * 10, "d": [d] * 10}


def corpo(**over):
    b = {"diaSemana": 1, "horaMin": 430, "trechos": {t: trecho() for t in DOZE}}
    b.update(over)
    return b


def test_prever_answers_every_segment(modelos):
    r = client.post("/ml/prever", json=corpo())
    assert r.status_code == 200
    out = r.json()
    assert out["modelo"].startswith("v2-")
    assert sorted(out["previsoes"]) == sorted(DOZE)
    for p in out["previsoes"].values():
        assert sorted(p) == ["f15", "f30", "v15", "v30"]
        assert all(isinstance(x, float) and math.isfinite(x) for x in p.values())
    # sem par: velocidade só -1, ou só null
    b = corpo(trechos={"I11>I12": trecho(v=-1.0), "I12>I13": {"v": [None] * 10, "f": [0.0] * 10, "d": [0.0] * 10}})
    r = client.post("/ml/prever", json=b)
    assert r.status_code == 200
    for p in r.json()["previsoes"].values():
        assert all(isinstance(x, float) and math.isfinite(x) for x in p.values())


def test_prever_rejects_bodies_outside_door_2(modelos):
    sem_hora = corpo()
    del sem_hora["horaMin"]
    nove = corpo(trechos={"I11>I12": {"v": [30.0] * 9, "f": [6.0] * 10, "d": [20.0] * 10}})
    for b in [sem_hora, nove, corpo(diaSemana=7), corpo(horaMin=1440)]:
        r = client.post("/ml/prever", json=b)
        assert r.status_code == 422, b
        body = r.json()
        assert body["erro"] == "entrada_invalida"
        assert body["detalhe"]
    assert any("horaMin" in d for d in client.post("/ml/prever", json=sem_hora).json()["detalhe"])


def test_without_model_answers_503_and_saude_null(tmp_path, monkeypatch):
    monkeypatch.setenv("ML_MODELOS", str(tmp_path / "vazio"))
    r = client.post("/ml/prever", json=corpo())
    assert (r.status_code, r.json()) == (503, {"erro": "modelo_ausente"})
    r = client.get("/ml/kmeans")
    assert (r.status_code, r.json()) == (503, {"erro": "modelo_ausente"})
    r = client.get("/ml/saude")
    assert (r.status_code, r.json()) == (200, {"status": "ok", "modelo": None, "treinadoEm": None})


def test_saude_with_model_reports_version_and_reloads(tmp_path, csv, monkeypatch):
    pasta = tmp_path / "servidos"
    monkeypatch.setenv("ML_MODELOS", str(pasta))
    assert client.get("/ml/saude").json()["modelo"] is None
    # treinado com o serviço no ar: passa a valer sem reiniciar
    m = treinar(csv, pasta)
    r = client.get("/ml/saude")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["modelo"] == m["versao"]
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00", body["treinadoEm"])
    assert client.post("/ml/prever", json=corpo()).status_code == 200
    # removido: volta a 503
    shutil.rmtree(pasta)
    assert client.post("/ml/prever", json=corpo()).status_code == 503


def test_kmeans_route_returns_door_7(modelos):
    r = client.get("/ml/kmeans")
    assert r.status_code == 200
    k = r.json()
    assert sorted(k) == ["centroides", "concordanciaRegraPct", "desvio", "media", "variaveis", "versao"]
    assert k["variaveis"] == ["velocidade_kmh", "fluxo_veic_min", "densidade_veic_km"]
    assert len(k["media"]) == 3 and len(k["desvio"]) == 3
    assert [c["nivel"] for c in k["centroides"]] == ["livre", "moderado", "intenso", "critico"]
    assert all(sorted(c) == ["centro", "nivel"] and len(c["centro"]) == 3 for c in k["centroides"])
    assert 0 <= k["concordanciaRegraPct"] <= 100
    assert k == json.loads((modelos / "kmeans.json").read_text())
