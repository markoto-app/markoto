FROM pandoc/extra:latest

RUN apk add --no-cache python3

COPY server.py /server.py

EXPOSE 8080

ENTRYPOINT []
CMD ["python3", "/server.py"]
